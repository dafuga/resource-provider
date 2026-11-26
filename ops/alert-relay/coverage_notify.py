#!/usr/bin/env python3
"""Run the read-only coverage check on a schedule and tell Chief of Staff what it finds.

Tracker 3vhnkz. Runs every 15 minutes from launchd (local.rp-coverage-check):
  - scripts/coverage-check.ts: inventory == provider managed list, floors and app gates,
    leases that would lapse within 6h without auto-renew;
  - scripts/scan-app-configs.ts (hourly): app config accounts missing from the inventory.
Findings go to the alert inbox item as one structured flag. A new finding is flagged at once,
an unchanged set at most every 6h. Dips that the manager normally fixes within seconds must
be seen on two runs. A flag the CLI refuses is not recorded as sent.
Nothing here signs or writes on chain or on the provider.
"""
import json
import os
import subprocess
import sys
import time

ITEM = "eha6tr"
APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STATE_DIR = os.path.expanduser("~/.local/state/rp-coverage")
TRACKER = os.path.expanduser("~/.local/bin/tracker")
BUN = os.path.expanduser("~/.bun/bin/bun")
REFLAG_SECONDS = 6 * 3600
SCAN_EVERY_SECONDS = 55 * 60
BROKEN_RUNS = 3
MAX_LISTED = 8
FLAG_OPTIONS = [
    "--option", "Fix coverage=a session enrols or funds the account, or fixes the check, and verifies the readback",
    "--option", "Watch only=leave it; the check keeps running and notes when it clears",
    "--recommend", "1",
]


def log(message):
    print(f"{time.strftime('%F %T')} {message}", file=sys.stderr, flush=True)


def tracker(*args):
    try:
        done = subprocess.run([TRACKER, *args], check=False, timeout=60,
                              stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    except (OSError, subprocess.SubprocessError) as error:
        log(f"tracker {args[0]} failed: {type(error).__name__}")
        return False
    if done.returncode:
        log(f"tracker {args[0]} refused (exit {done.returncode}): {done.stderr.strip()[:300]}")
    return done.returncode == 0


def run_script(name, *args, timeout=600):
    try:
        done = subprocess.run([BUN, f"scripts/{name}", *args], cwd=APP, check=False,
                              capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as error:
        return 2, "", type(error).__name__
    return done.returncode, done.stdout, done.stderr


def coverage_findings(run=run_script):
    """(findings, report) from the chain/provider check, or (None, reason) if it could not run."""
    code, out, err = run("coverage-check.ts", "--json")
    try:
        report = json.loads(out.strip().splitlines()[-1])
        if code in (0, 1):
            return report["findings"], report
    except (ValueError, IndexError, KeyError):
        pass
    return None, (err or out).strip()[-300:]


def scan_findings(run=run_script):
    code, out, err = run("scan-app-configs.ts")
    unknown = [{"key": "app-config:" + line.split()[1].rstrip(":"), "immediate": True,
                "message": "app config names an account missing from the inventory: " + line[8:]}
               for line in out.splitlines() if line.startswith("UNKNOWN ")]
    if code in (0, 1):
        return unknown, None
    return None, (out + err).strip()[-300:]


def step(state, now, findings, flag, note):
    """Decide what to send for this run's findings. Mutates state."""
    seen = state.get("seen", {})
    confirmed = {f["key"]: f["message"] for f in findings if f["immediate"] or f["key"] in seen}
    state["seen"] = {f["key"]: f["message"] for f in findings}
    sent = state.setdefault("sent", {})
    cleared = [key for key in sent if key not in state["seen"]]
    if cleared and note(f"[coverage] cleared: {', '.join(sorted(cleared))}"):
        for key in cleared:
            del sent[key]
    due = [key for key in confirmed if now - sent.get(key, 0) >= REFLAG_SECONDS]
    if not due:
        return
    due.sort(key=lambda key: (sent.get(key, 0), key))
    listed = due[:MAX_LISTED]
    more = f" (+{len(due) - len(listed)} more in report.json)" if len(due) > len(listed) else ""
    if flag(f"[coverage] {len(confirmed)} problem(s) in RNG account coverage: "
            + " | ".join(confirmed[key][:300] for key in listed) + more):
        for key in listed:
            sent[key] = now


def track_broken(state, name, reason, flag):
    """Flag a check that cannot run BROKEN_RUNS times in a row; silence is not coverage."""
    broken = state.setdefault("broken", {})
    entry = broken.setdefault(name, {"runs": 0, "flagged": False})
    if reason is None:
        broken[name] = {"runs": 0, "flagged": False}
        return
    entry["runs"] += 1
    log(f"{name} could not run: {reason}")
    if entry["runs"] >= BROKEN_RUNS and not entry["flagged"]:
        entry["flagged"] = flag(f"[coverage] the {name} has not been able to run {entry['runs']} "
                                f"times in a row on the primary Mac: {reason[:300]}")


def save(path, value):
    with open(path + ".tmp", "w") as f:
        json.dump(value, f, indent=1)
    os.replace(path + ".tmp", path)


def main():
    os.makedirs(STATE_DIR, exist_ok=True)
    path = os.path.join(STATE_DIR, "state.json")
    try:
        with open(path) as f:
            state = json.load(f)
    except (OSError, ValueError):
        state = {}
    now = time.time()

    def flag(text):
        return tracker("flag", ITEM, text, *FLAG_OPTIONS)

    findings, report = coverage_findings()
    if findings is None:
        track_broken(state, "coverage check", report, flag)
    else:
        track_broken(state, "coverage check", None, flag)
        save(os.path.join(STATE_DIR, "report.json"), report)

    if now - state.get("scanned_at", 0) >= SCAN_EVERY_SECONDS:
        scanned, reason = scan_findings()
        track_broken(state, "app config scan", reason, flag)
        if scanned is not None:
            state["scanned_at"], state["scan"] = now, scanned

    # A failed run keeps the previous findings state: it must not look like a recovery.
    if findings is not None:
        step(state, now, findings + state.get("scan", []), flag, lambda text: tracker("note", ITEM, text))
    state["last_run"] = now
    save(path, state)
    log(f"checked: {'could not run' if findings is None else str(len(findings)) + ' finding(s)'}, "
        f"{len(state.get('scan', []))} unlisted app account(s)")
    return 0 if findings is not None else 1


if __name__ == "__main__":
    sys.exit(main())
