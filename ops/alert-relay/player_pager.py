#!/usr/bin/env python3
"""Poll Tracker for P1 player alerts and retain acknowledgement and escalation receipts."""
import argparse
from datetime import datetime, timezone
from functools import cache
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from math import isfinite
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


FRONTIER_ORIGIN = "https://rng-frontier.pages.dev"
SPONSOR_ORIGIN = "https://rng-sponsor-jungle4.danielfugere28.workers.dev"
CHAIN = "73e4385a2708e6d7048834fbc1079f2fabb17b3c125b146af438971e90716c4d"
FRONTIER_URLS = {"release": FRONTIER_ORIGIN + "/version.json", "page": FRONTIER_ORIGIN + "/",
                 "sponsor": SPONSOR_ORIGIN + "/health"}


def public_get(url):
    # curl bounds DNS, TLS and the entire body transfer. Ignore user config, proxies and redirects.
    result = subprocess.run(["/usr/bin/curl", "-q", "--silent", "--noproxy", "*", "--max-time", "4",
                             "--max-filesize", "262144", "--write-out", "\n%{http_code}", url],
                            capture_output=True, timeout=5)
    body, _, status = result.stdout.rpartition(b"\n")
    return result.returncode, int(status) if status.isdigit() else 0, body


def frontier_read(target):
    url = FRONTIER_URLS[target]
    try:
        code, status, body = public_get(url)
        if code:
            # A busy/offline second observer is not independent confirmation. Check its egress
            # before counting a second connect/DNS failure or deadline as an outage.
            if code in (6, 7, 28) and os.getloadavg()[0] < (os.cpu_count() or 1):
                control, control_status, _ = public_get("https://www.cloudflare.com/cdn-cgi/trace")
                if control == 0 and control_status == 200:
                    return "failed", f"unreachable (curl {code}, control HTTP 200)"
            return "unknown", f"unavailable (curl {code})"
        if status == 404 or 500 <= status <= 599:
            return "failed", f"HTTP {status}"
        if status != 200:
            return "unknown", f"HTTP {status}"
        if target == "page":
            valid = b'id="game-canvas"' in body
        else:
            data = json.loads(body)
            valid = isinstance(data, dict) and (data.get("ok") is True if target == "sponsor" else
                    bool(re.fullmatch("[a-f0-9]{40}", str(data.get("commit")))) and
                    data.get("chainId") == CHAIN and data.get("resourceProviderUrl") == SPONSOR_ORIGIN)
        return ("healthy", "HTTP 200") if valid else ("failed", "HTTP 200 unexpected content")
    except (ValueError, UnicodeError):
        return "failed", "HTTP 200 invalid JSON"
    except (OSError, subprocess.TimeoutExpired):
        return "unknown", "observer unavailable"


def frontier_fields(payload):
    try:
        data = json.loads(payload)
    except (ValueError, TypeError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    # Store only fields used in the decision; Tracker may contain an old or truncated record.
    return {k: data[k] for k in ("stage", "status", "reason", "reasons", "errorClass", "errorCode", "hostLoad",
                                  "ok", "quoteRequestSent", "signRequestSent") if k in data}


def frontier_verdict(channel, data, read=None):
    stage = data.get("stage")
    target = ("sponsor" if channel in ("quote", "sign", "budget") else
              "release" if stage == "release_metadata" else "page")
    outcome, detail = (read or frontier_read)(target)
    load = data.get("hostLoad")
    load = load if isinstance(load, dict) else {}

    def numeric(key):
        value = load.get(key)
        return value if type(value) in (float, int) and 0 <= value < 1e7 and isfinite(value) else None

    values = [numeric(k) for k in ("load1", "load5", "load15", "cpus")]
    host = "/".join(str(v) if v is not None else "?" for v in values[:3])
    # The source already applied its consecutive-failure gate. Only ambiguous timeouts need
    # two observers. An explicit sponsor rejection keeps its original first eligible poll.
    reasons = data.get("reasons")
    timeout = (data.get("errorClass") == "timeout" or data.get("reason") == "browser_probe_timeout" or
               data.get("errorCode") in ("TimeoutError", "ETIMEDOUT", "ERR_TIMED_OUT"))
    cpu = values[3]
    overloaded = not cpu or values[0] is None or max(v or 0 for v in values[:2]) >= cpu
    if data.get("ok") is True:
        confirmed = False  # Recovered before a refused failure notification was delivered.
    elif channel == "budget":
        confirmed = isinstance(reasons, list) and any(
            r in ("sponsor_budget_exhausted", "sustained_http_429") for r in reasons)
    elif channel == "heartbeat" or not data or (timeout and overloaded):
        confirmed = outcome == "failed"
    else:
        confirmed = True
    return {"tier": "p1" if confirmed else "warning",
            "result": f"MB2 load {host} on {values[3] or '?'} CPUs; primary {target}: {detail}"}


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
            if frontier:
                event["frontier"] = frontier_fields(frontier[3])
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


def process(state, clock, cos, reflag, slack_dm, save, record_evidence=None):
    failed = False
    read_this_poll = cache(frontier_read)
    for event_id, event in list(state["events"].items()):
        if event.get("resolved"):
            continue
        now = clock()
        paged_at = event.get("cos_at")
        ack = event.get("ack_at")
        item = event["item"]
        observed = datetime.fromtimestamp(event["detected_at"], tz=timezone.utc).isoformat(timespec="seconds")
        subject = f"{event['summary']} at {observed} on Tracker {item}"
        if item in FRONTIER and event.get("source_key") in ("probe/page", "quote", "sign", "heartbeat", "budget"):
            # A pre-upgrade pending page needs the same gate before its first escalation.
            if paged_at is None or "frontier_receipt" not in event:
                if ack is not None and paged_at is not None and ack <= paged_at + ACK_SECONDS:
                    continue
                verdict = frontier_verdict(event["source_key"], event.get("frontier", {}), read_this_poll)
                event["evidence"] = verdict
                if verdict["tier"] == "warning":
                    if "cos_at" in event:
                        del event["cos_at"]
                    if "warning" not in event:
                        if cos(f"Frontier monitor health warning. {subject}. {verdict['result']}"):
                            event["warning"] = verdict["result"]
                            save()
                        else:
                            failed = True
                    continue
                event["frontier_receipt"] = verdict["result"]
            subject += ". " + event["frontier_receipt"]
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

    # Persist the actual second-vantage result beside the MB2 candidate. An unavailable
    # Tracker write must not delay a page or require a second successful CoS delivery.
    if record_evidence:
        for event_id, event in state["events"].items():
            evidence = event.get("evidence")
            if not evidence or event.get("recorded_tier") == evidence["tier"]:
                continue
            message = f"Frontier {evidence['tier']} evidence {event_id}. {evidence['result']}"
            if record_evidence(event["item"], message):
                event["recorded_tier"] = evidence["tier"]
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


def record_frontier_evidence(item, message):
    command([TRACKER, "note", item, message])
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Read Tracker and report counts without sending or saving.")
    parser.add_argument("--frontier-vantage", choices=("probe/page", "quote", "sign", "heartbeat", "budget"))
    args = parser.parse_args()
    if args.frontier_vantage:
        print(json.dumps(frontier_verdict(args.frontier_vantage, frontier_fields(sys.stdin.read(4096)))))
        return 0
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
                        attempt("Tracker escalation", reflag), attempt("Slack DM", send_slack_page), save,
                        attempt("Tracker evidence", record_frontier_evidence)) else 1


if __name__ == "__main__":
    raise SystemExit(main())
