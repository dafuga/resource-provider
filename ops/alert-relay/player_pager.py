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

import watch
from watch import log

TRACKER = Path.home() / ".local/bin/tracker"
TMUX = "/opt/homebrew/bin/tmux"
STATE = Path.home() / ".local/state/player-pager.json"
SLACK_DM = "D0CN4BTE5TJ"
SLACK_BOT = "B0CN4BTDN6L"
SLACK_WORKSPACE = "T0CHRK2DS0M"
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


PROVIDER_ALERT = re.compile(r"\[P1 player\] \[resource-provider\] (\S+) ([a-z-]+:[a-z0-9.]+):")
PROVIDER_RECOVERY = re.compile(r"\[resource-provider\] RESOLVED (\S+): .* \(key ([^() ]+)\)$")
FRONTIER_EVENT = re.compile(r"Production Frontier Build Settlement ([a-z/]+) (failure|recovered) (.*)")
KEEPER_ALERT = re.compile(r"RNG (blackjack|craps|poker) keeper failing ")


def frontier_time(payload, fallback):
    detected = re.search(r'"time"\s*:\s*"([^"]+)"', payload)
    return (timestamp(detected[1]) or fallback) if detected else fallback


def recovery_index(item):
    recovered = {}
    for note in item.get("notes_log") or ():
        message = note["text"]
        provider = PROVIDER_RECOVERY.match(message) if item["id"] == PROVIDER else None
        frontier = FRONTIER_EVENT.match(message) if item["id"] in FRONTIER else None
        if provider:
            at, key = timestamp(provider[1]), provider[2]
        elif frontier and frontier[2] == "recovered":
            key = frontier[1]
            at = frontier_time(frontier[3], timestamp(note["at"]))
        else:
            continue
        recovered[key] = max(recovered.get(key, 0), at)
    return recovered


def ingest(state, items):
    events = state["events"]
    activation = state.get("activation_at", state["start"])

    for item in items:
        item_id = item["id"]
        if item.get("deleted") or item.get("sensitive") or not re.fullmatch(r"[a-z0-9]{10}", item_id):
            continue
        recovered = recovery_index(item)
        keeper_closed = item.get("owner") == "rng-keeper-watch" and item.get("status") == "done"

        def add(message, received_at, open_question=False):
            if not is_player_alert(item, message):
                return
            event_id = hashlib.sha256(f"{item_id}\n{message}".encode()).hexdigest()[:20]
            summary = "production player monitor"
            key, at = None, received_at
            provider = PROVIDER_ALERT.match(message) if item_id == PROVIDER else None
            frontier = FRONTIER_EVENT.match(message) if item_id in FRONTIER else None
            keeper = KEEPER_ALERT.match(message)
            if provider:
                at = timestamp(provider[1]) or at
                key = provider[2]
                summary = f"Resource Provider {key}"
            elif frontier:
                key = frontier[1]
                at = frontier_time(frontier[3], at)
                summary = f"Frontier {key}"
            elif keeper:
                summary = f"RNG {keeper[1]} keeper"
            elif item_id == PROVIDER:
                summary = "Resource Provider"

            if keeper_closed or (key and recovered.get(key, 0) >= at):
                if event_id in events:
                    events[event_id]["resolved"] = True
                return
            # Unpaired Provider events and open monitor questions can survive a restart.
            # Unverified pre-activation notes have no evidence that the incident is still open.
            if received_at < state["start"] or (at < activation and not (provider or open_question)):
                return
            event = events.setdefault(event_id, {
                "item": item_id, "detected_at": at, "received_at": received_at, "summary": summary,
            })
            if key:
                event["source_key"] = key

        notes = item.get("notes_log") or ()
        for note in notes:
            message = note["text"]
            if message.startswith(ALERT_NOTE):
                add(message.removeprefix(ALERT_NOTE), timestamp(note["at"]))
        if item.get("status") not in ("done", "ignored") and item.get("needs_daniel") and item.get("question"):
            add(item["question"], timestamp(item["updated_at"]), open_question=True)

        for event_id, event in events.items():
            if event["item"] != item_id:
                continue
            if keeper_closed or recovered.get(event.get("source_key"), 0) >= event["detected_at"]:
                event["resolved"] = True
            if "ack_at" in event or event.get("resolved"):
                continue
            marker = f"P1 ACK {event_id}"
            for note in notes:
                at = timestamp(note["at"])
                if note["text"].strip() == marker and at >= event.get("cos_at", event["detected_at"]):
                    event["ack_at"] = at
                    break


def process(state, clock, cos, reflag, slack_dm, save):
    failed = False
    for event_id, event in list(state["events"].items()):
        if event.get("resolved"):
            continue
        now = clock()
        paged_at = event.get("cos_at")
        ack = event.get("ack_at")
        item = event["item"]
        observed = datetime.fromtimestamp(event["detected_at"], tz=timezone.utc).isoformat(timespec="seconds")
        subject = f"{event['summary']} at {observed} on Tracker {item}"
        if paged_at is None:
            if ack is not None:
                continue
            ack_command = f'tracker note {item} "P1 ACK {event_id}"'
            prompt = (
                f"P1 PROD PLAYER ALERT {event_id}. {subject}. "
                "Read the matching monitor alert, acknowledge receipt now, and triage. "
                f"Record the acknowledgement with {ack_command}. "
                "This P1 rule applies at night as well."
            )
            if cos(prompt):
                event["cos_at"] = clock()
                save()
            else:
                failed = True
            continue
        deadline = paged_at + ACK_SECONDS
        if now < deadline or (ack is not None and ack <= deadline):
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
        if "slack_receipt" not in event:
            receipt = slack_dm(message)
            if receipt:
                event["slack_receipt"] = receipt
                save()
            else:
                failed = True

    # Retain completed ids as long as their source observations can be admitted again.
    state["start"] = max(state["start"], clock() - RETENTION_SECONDS)
    for event_id, event in list(state["events"].items()):
        paged_at = event.get("cos_at", 0)
        completed = event.get("resolved") or event.get("ack_at", float("inf")) <= paged_at + ACK_SECONDS or (
            "reflag_at" in event and "slack_receipt" in event
        )
        observed_at = event.get("received_at", event["detected_at"])
        if completed and max(observed_at, paged_at) < state["start"]:
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


def send_slack_page(message):
    """Send through the approved bot to its existing conversation with Daniel."""
    identity = watch.slack("auth.test", {})
    if identity.get("bot_id") != SLACK_BOT or identity.get("team_id") != SLACK_WORKSPACE:
        raise RuntimeError("Slack bot or workspace mismatch")
    if watch.dm_channel() != SLACK_DM:
        raise RuntimeError("Slack DM mismatch")
    result = watch.slack("chat.postMessage", {
        "channel": SLACK_DM, "text": message, "unfurl_links": False,
    })
    receipt = result.get("ts", "")
    if result.get("channel") != SLACK_DM or not re.fullmatch(r"\d+\.\d+", receipt):
        raise RuntimeError("Slack DM post not confirmed")
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
        state = {"start": now - RETENTION_SECONDS, "events": {}}
    state.setdefault("activation_at", now)

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
    return 0 if process(state, time.time, attempt("CoS", deliver_to_cos),
                        attempt("Tracker escalation", reflag), attempt("Slack DM", send_slack_page), save) else 1


if __name__ == "__main__":
    raise SystemExit(main())
