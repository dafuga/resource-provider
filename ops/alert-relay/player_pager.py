#!/usr/bin/env python3
"""Poll Tracker for P1 player alerts and retain acknowledgement and escalation receipts."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

from watch import get_json, log

TRACKER = Path.home() / ".local/bin/tracker"
TMUX = "/opt/homebrew/bin/tmux"
STATE = Path.home() / ".local/state/player-pager.json"
JOT_CHANNEL = "D0CJ0JX361J"
JOT_USER = "U0CHQLXDT4K"
JOT_WORKSPACE = "T0CHRK2DS0M"
JOT_SECRET = [
    "/opt/homebrew/bin/gcloud", "secrets", "versions", "access", "latest",
    "--project=buildflexity-app", "--secret=rng-player-pager-jot-token",
]
ACK_SECONDS = 15 * 60
RETENTION_SECONDS = 24 * 3600
ALERT_NOTE = "watchdog alert: "
P1 = "[P1 player] "
ESCALATION = "[P1 player escalation]"
FRONTIER = {"jsx1zsn228", "66bp04f3yb"}
PROVIDER = "eha6trgdbh"


def timestamp(value):
    try:
        return datetime.fromisoformat(value).timestamp()
    except (TypeError, ValueError):
        return 0


def is_player_alert(item, message):
    if message.startswith(P1):
        return True
    if item["id"] in FRONTIER:
        return bool(re.match(
            r"Production Frontier Build Settlement (quote|sign|heartbeat|budget|probe/page) failure ",
            message,
        ))
    if item["id"] == PROVIDER:
        return message.startswith(("[resource-provider] ALERT ", "[coverage] ", "RP alert relay "))
    return (item.get("owner") == "rng-keeper-watch"
            and bool(re.match(r"RNG (blackjack|craps|poker) keeper failing ", message)))


def ingest(state, items):
    events = state["events"]
    start = state["start"]

    def add(item, message, at):
        if at < start or not is_player_alert(item, message):
            return
        event_id = hashlib.sha256(f"{item['id']}\n{message}".encode()).hexdigest()[:20]
        summary = "production player monitor"
        provider = re.match(r"\[P1 player\] \[resource-provider\] (\S+) ([a-z-]+:[a-z0-9.]+):", message)
        frontier = re.match(r"Production Frontier Build Settlement ([a-z/]+) failure ", message)
        keeper = re.match(r"RNG (blackjack|craps|poker) keeper failing ", message)
        if provider:
            at = timestamp(provider[1]) or at
            summary = f"Resource Provider {provider[2]}"
        elif frontier:
            summary = f"Frontier {frontier[1]}"
        elif keeper:
            summary = f"RNG {keeper[1]} keeper"
        elif item["id"] == PROVIDER:
            summary = "Resource Provider"
        events.setdefault(event_id, {"item": item["id"], "detected_at": at, "summary": summary})

    for item in items:
        if item.get("deleted") or item.get("sensitive") or not re.fullmatch(r"[a-z0-9]{10}", item["id"]):
            continue
        for note in item.get("notes_log") or ():
            message = note["text"]
            if message.startswith(ALERT_NOTE):
                add(item, message.removeprefix(ALERT_NOTE), timestamp(note["at"]))
        if item.get("status") not in ("done", "ignored") and item.get("needs_daniel") and item.get("question"):
            question = item["question"]
            at = timestamp(item["updated_at"])
            if item["id"] in FRONTIER:
                detected = re.search(r'"time":"([^"]+)"', question)
                if detected:
                    at = timestamp(detected[1]) or at
            add(item, question, at)

    by_id = {item["id"]: item for item in items}
    for event_id, event in events.items():
        if "ack_at" in event:
            continue
        marker = f"P1 ACK {event_id}"
        item = by_id.get(event["item"], {})
        for note in item.get("notes_log") or ():
            at = timestamp(note["at"])
            if note["text"].strip() == marker and at >= event["detected_at"]:
                event["ack_at"] = at
                break


def process(state, now, cos, reflag, jot, save):
    failed = False
    for event_id, event in list(state["events"].items()):
        deadline = event["detected_at"] + ACK_SECONDS
        ack = event.get("ack_at")
        if ack is not None and ack <= deadline:
            continue
        item = event["item"]
        observed = datetime.fromtimestamp(event["detected_at"], tz=timezone.utc).isoformat(timespec="seconds")
        subject = f"{event['summary']} at {observed} on Tracker {item}"
        if "cos_at" not in event and ack is None:
            ack_command = f'tracker note {item} "P1 ACK {event_id}"'
            prompt = (
                f"P1 PROD PLAYER ALERT {event_id}. {subject}. "
                "Read the matching monitor alert, acknowledge receipt now, and triage. "
                f"Record the acknowledgement with {ack_command}. "
                "This P1 rule applies at night as well."
            )
            if cos(prompt):
                event["cos_at"] = now
                save()
            else:
                failed = True
        if now < deadline:
            continue

        message = (
            f"{ESCALATION} {event_id}: CoS missed the 15-minute acknowledgement "
            f"deadline for {subject}. Check the monitor alert and triage."
        )
        if "reflag_at" not in event:
            if reflag(item, message):
                event["reflag_at"] = now
                save()
            else:
                failed = True
        if "jot_receipt" not in event:
            receipt = jot(message)
            if receipt:
                event["jot_receipt"] = receipt
                save()
            else:
                failed = True

    # Retain completed ids as long as their source observations can be admitted again.
    state["start"] = max(state["start"], now - RETENTION_SECONDS)
    for event_id, event in list(state["events"].items()):
        deadline = event["detected_at"] + ACK_SECONDS
        completed = event.get("ack_at", float("inf")) <= deadline or (
            "reflag_at" in event and "jot_receipt" in event
        )
        if completed and event["detected_at"] < state["start"]:
            del state["events"][event_id]
    save()
    return not failed


def command(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=15)
    if result.returncode:
        raise RuntimeError(f"{Path(args[0]).name} exit {result.returncode}")
    return result.stdout.strip()


def deliver_to_cos(message):
    pane, tty, session = command([
        TMUX, "display-message", "-p", "-t", "=cos:",
        "#{pane_id} #{pane_tty} #{session_name}",
    ]).split()
    if session != "cos" or not re.fullmatch(r"%\d+", pane) or not re.fullmatch(r"/dev/ttys\d+", tty):
        return False
    processes = command(["/bin/ps", "-t", tty.removeprefix("/dev/"), "-o", "stat=,comm="])
    if not re.search(r"^\s*\S*\+\S*\s+(?:\S*/)?claude\s*$", processes, re.MULTILINE):
        return False
    command([TMUX, "send-keys", "-t", pane, "-l", message])
    command([TMUX, "send-keys", "-t", pane, "Enter"])
    return True


def send_to_jot(message):
    # Use only the dedicated, authorized self-DM binding. Keep API errors and token contents private.
    token = command(JOT_SECRET)
    if not token:
        raise RuntimeError("Jot token file empty")
    headers = {"Authorization": f"Bearer {token}"}
    identity = get_json("https://slack.com/api/auth.test", {}, headers)
    if (not identity.get("ok") or identity.get("user_id") != JOT_USER
            or identity.get("team_id") != JOT_WORKSPACE or identity.get("bot_id")):
        raise RuntimeError("Jot account mismatch")
    result = get_json("https://slack.com/api/chat.postMessage", {
        "channel": JOT_CHANNEL, "text": message, "unfurl_links": False,
    }, headers)
    receipt = result.get("ts", "")
    if not result.get("ok") or result.get("channel") != JOT_CHANNEL or not re.fullmatch(r"\d+\.\d+", receipt):
        raise RuntimeError("Jot post not confirmed")
    return receipt


def attempt(label, operation):
    def run(*args):
        try:
            return operation(*args)
        except Exception as error:
            log(f"player pager {label} failed ({type(error).__name__})")
            return False
    return run


def reflag(item, message):
    command([TRACKER, "alert", item, message])
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Read Tracker and report counts without sending or saving.")
    args = parser.parse_args()
    now = time.time()
    try:
        state = json.loads(STATE.read_text())
    except FileNotFoundError:
        state = {"start": now - ACK_SECONDS, "events": {}}

    active = json.loads(command([TRACKER, "list", "--json"]))
    # Keeper items can close on recovery before the next poll. Their alert/ack notes still count.
    closed_rng = json.loads(command([TRACKER, "list", "--status", "done", "--agent", "rng", "--json"]))
    items = {item["id"]: item for item in closed_rng + active}
    for item_id in {event["item"] for event in state["events"].values() if "ack_at" not in event} - items.keys():
        read = attempt("Tracker item read", command)([TRACKER, "show", item_id, "--json"])
        if read:
            items[item_id] = json.loads(read)
    ingest(state, items.values())
    if args.dry_run:
        print(f"{len(state['events'])} events tracked")
        return 0

    def save():
        temp = STATE.with_suffix(".tmp")
        with os.fdopen(os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as file:
            json.dump(state, file)
        temp.replace(STATE)

    # A Tracker read failure leaves the last state intact and exits nonzero.
    save()
    return 0 if process(state, time.time(), attempt("CoS", deliver_to_cos),
                        attempt("Tracker escalation", reflag), attempt("Jot", send_to_jot), save) else 1


if __name__ == "__main__":
    raise SystemExit(main())
