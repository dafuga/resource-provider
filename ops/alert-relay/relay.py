#!/usr/bin/env python3
"""Relay Resource Provider runway alerts from the GCP VM journal to the shared tracker.

Tracker item dnx8hx / alert inbox eha6tr (2026-11-25, alert-only deploy of 2e4f6d8).
Runs every 5 minutes from launchd (local.rp-alert-relay). Reads only `ALERT:` / `RESOLVED:`
lines of resource-provider.service over IAP SSH, and:
  - records cpu-low, payer-dry and ram-cap episodes immediately, including short episodes
    that clear before the next poll; the CoS pager handles their acknowledgement deadline
  - flags other new firing alerts, with a six-hour minimum between reminders
  - sends every due alert in ONE flag, so one flag never overwrites another in the same run;
    a flag the CLI refuses is not marked sent and is retried on the next run
  - flags once if the 15-minute coverage check (coverage_notify.py, 3vhnkz) stops running
  - notes the inbox item when that alert resolves
  - flags once if the VM journal cannot be read for 3 consecutive runs
Alert lines carry account names and balances only.
ztryv8: watch.py also DMs Daniel on Slack (provider balance alerts and runway read from chain).
"""
import json
import os
import re
import subprocess
import sys
import time

import watch

ITEM = "eha6tr"
STATE = os.path.expanduser("~/.local/share/rp-alert-relay/state.json")
TRACKER = os.path.expanduser("~/.local/bin/tracker")
GCLOUD = "/opt/homebrew/bin/gcloud"
SSH = [GCLOUD, "compute", "ssh", "buildflexity-app", "--project", "buildflexity-app",
       "--zone", "northamerica-northeast1-a", "--tunnel-through-iap", "--quiet", "--command"]
# cxvh89 (26 Nov): also per-account failures and liquid-balance floors for the sponsor RAM payers.
# These incidents can affect a live game even if they clear within a polling interval.
CRITICAL = ("cpu-low:", "payer-dry:", "ram-cap:")
RELAYED = ("payer-balance:", "payer-funding:", "self-stale", "self-verify",
           "balance-low:", "balance-funding:", "manage-failed:",
           "lease-expiring:", "ram-max-fee:", *CRITICAL)
# The service re-logs a firing alert every 30 min and forgets it on restart without logging
# RESOLVED, so an alert silent for this long is over.
FIRING_WINDOW = 2 * 3600
COVERAGE_STATE = os.path.expanduser("~/.local/state/rp-coverage/state.json")
COVERAGE_STALE_SECONDS = 2 * 3600
# Tracker flags must carry choices and a recommendation, or the CLI refuses them.
FLAG_OPTIONS = ["--option", "Fund it now=a session tops the account up from our Jungle 4 test accounts and checks why the provider missed it",
                "--option", "Watch only=leave it; the provider retries every cycle and this item gets a note when it clears",
                "--recommend", "1"]
REFLAG_SECONDS = 6 * 3600
MAX_ALERTS_PER_FLAG = 8
LINE = re.compile(r"^(\S+) \S+ \S+: (ALERT|RESOLVED): (.*?)(?: (\{.*\}))?$")


def load():
    try:
        with open(STATE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"cursor": None, "keys": {}, "failures": 0, "failure_flagged": False}


def save(state):
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=1)
    os.replace(tmp, STATE)


def tracker(*args):
    """Run the tracker CLI; a refusal is logged (never silent) and reported as False."""
    try:
        done = subprocess.run([TRACKER, *args], check=False, timeout=60,
                              stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    except (OSError, subprocess.SubprocessError) as error:
        watch.log(f"tracker {args[0]} failed: {type(error).__name__}")
        return False
    if done.returncode:
        watch.log(f"tracker {args[0]} {args[1]} refused (exit {done.returncode}): {done.stderr.strip()[:300]}")
    return done.returncode == 0


def slack_watch(state, now):
    def fallback(message):
        return tracker("flag", ITEM, message, *FLAG_OPTIONS)

    try:
        watch.check(state, state.get("keys", {}), now, watch.live_io(fallback))
    except Exception as error:  # noqa: BLE001 - never stop the tracker relay
        watch.log(f"slack watch failed: {type(error).__name__}: {error}")


def read_journal(cursor):
    if cursor and re.fullmatch(r"[A-Za-z0-9=;_-]+", cursor):
        since = f"'--after-cursor={cursor}'"
    else:
        since = "--since=-15min"
    remote = (f"set -o pipefail; sudo journalctl -u resource-provider --no-pager -o cat --show-cursor {since}"
              " | awk '/(ALERT|RESOLVED): |^-- cursor: /'")
    out = subprocess.run([*SSH, remote], capture_output=True, text=True, timeout=120)
    if out.returncode:
        raise RuntimeError(f"ssh exit {out.returncode}")
    return out.stdout.splitlines()


def apply_lines(keys, lines, now, note, pending):
    """Fold new journal lines into the per-alert state."""
    for raw in lines:
        m = LINE.match(raw.strip())
        if not m:
            continue
        at, kind, message, details = m.groups()
        try:
            key = json.loads(details or "{}").get("alert", "")
        except ValueError:
            key = ""
        if not key.startswith(RELAYED):
            continue
        entry = keys.setdefault(key, {"active": False, "flagged_at": 0})
        if kind == "ALERT":
            if not entry["active"] or now - entry.get("last_seen", 0) > FIRING_WINDOW:
                entry.update(active=True, since=now, delivered=False)
                entry.pop("critical_event", None)
            if key.startswith(CRITICAL) and not entry.get("critical_event"):
                event = f"{at} {key}"
                entry["critical_event"] = event
                pending[event] = {"alert": f"[P1 player] [resource-provider] {event}: {message[:300]}"}
            entry["last_seen"] = now
            entry["at"] = at
            entry["message"] = message[:300]
        elif entry["active"]:
            entry["active"] = False
            # Only say "resolved" about something that was actually delivered.
            recovery = f"[resource-provider] RESOLVED {at}: {message} (key {key})"
            if event := entry.pop("critical_event", None):
                pending.setdefault(event, {})["recovery"] = recovery
            elif entry.get("delivered"):
                note(recovery)


def due_alerts(keys, now):
    due = []
    for key, entry in keys.items():
        if not entry.get("active") or now - entry.get("last_seen", 0) > FIRING_WINDOW:
            continue
        if key.startswith(CRITICAL):
            continue
        if now - entry.get("flagged_at", 0) >= REFLAG_SECONDS:
            due.append(key)
    # Never-delivered alerts first.
    return sorted(due, key=lambda k: (keys[k].get("flagged_at", 0), keys[k].get("since", 0)))


def send_due(keys, now, flag):
    due = due_alerts(keys, now)[:MAX_ALERTS_PER_FLAG]
    if not due:
        return
    listed = " | ".join(f"{keys[k].get('at', '')}: {keys[k].get('message', '')} (key {k})" for k in due)
    if flag(f"[resource-provider] ALERT {listed}. The Resource Provider keeps every enrolled "
            "account resourced from payer rsfui4ahy.gm (cxvh89); fund the payer or the named "
            "account from our Jungle 4 test accounts."):
        for key in due:
            keys[key].update(flagged_at=now, delivered=True)


def send_critical(pending, notify):
    """Persist each successful operation and retry failed operations in order."""
    for event, messages in list(pending.items()):
        if "alert" in messages:
            if not notify("alert", ITEM, messages["alert"]):
                continue
            del messages["alert"]
        if "recovery" not in messages or notify("note", ITEM, messages["recovery"]):
            del pending[event]
    return not pending


def check_coverage_alive(state, now, path=COVERAGE_STATE):
    """Dead-man for the coverage check: silence must not look like coverage."""
    try:
        with open(path) as f:
            last = json.load(f).get("last_run", 0)
    except (OSError, ValueError):
        return
    if now - last < COVERAGE_STALE_SECONDS:
        state["coverage_stale_flagged"] = False
    elif not state.get("coverage_stale_flagged"):
        state["coverage_stale_flagged"] = tracker(
            "flag", ITEM, "RNG coverage check has not run for over 2 hours on the primary Mac "
            "(LaunchAgent local.rp-coverage-check). Unenrolled accounts and lapsing leases are "
            "not being checked.",
            "--option", "Restore the check=a session fixes the LaunchAgent and reruns it",
            "--option", "Watch only=leave it; the provider alerts are still relayed",
            "--recommend", "1")


def main():
    state = load()
    now = time.time()
    try:
        lines = read_journal(state.get("cursor"))
    except Exception as error:  # noqa: BLE001 - any failure counts as unreachable
        state["failures"] = state.get("failures", 0) + 1
        if state["failures"] >= 3 and not state.get("failure_flagged"):
            state["failure_flagged"] = tracker("flag", ITEM, f"RP alert relay cannot read the buildflexity-app journal for "
                    f"{state['failures']} runs ({type(error).__name__}). Alerts are still logged on "
                    "the VM but not reaching the tracker. Check gcloud auth / IAP from the primary Mac.",
                    "--option", "Fix relay access=a session restores gcloud/IAP access for the relay",
                    "--option", "Watch only=leave it; the relay retries every 5 minutes",
                    "--recommend", "1")
        send_critical(state.setdefault("critical_pending", {}), tracker)
        save(state)
        slack_watch(state, now)
        save(state)
        return 1
    if state.get("failure_flagged"):
        tracker("note", ITEM, "RP alert relay can read the VM journal again.")
    state["failures"], state["failure_flagged"] = 0, False

    keys = state.setdefault("keys", {})
    pending = state.setdefault("critical_pending", {})
    apply_lines(keys, lines, now, lambda text: tracker("note", ITEM, text), pending)
    for line in reversed(lines):
        if line.startswith("-- cursor: "):
            state["cursor"] = line.removeprefix("-- cursor: ")
            break
    # Save the journal position and unsent queue together before attempting delivery.
    save(state)
    critical_ok = send_critical(pending, tracker)
    save(state)
    send_due(keys, now, lambda text: tracker("flag", ITEM, text, *FLAG_OPTIONS))
    check_coverage_alive(state, now)
    slack_watch(state, now)
    save(state)
    return 0 if critical_ok else 1


if __name__ == "__main__":
    sys.exit(main())
