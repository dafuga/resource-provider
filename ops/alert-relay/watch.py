#!/usr/bin/env python3
"""Slack DM leg and runway watch for the Resource Provider relay (tracker ztryv8).

Daniel is DMed by the BuildFlexity Alerts bot (a bot DM notifies; a self-DM does not).
The bot token is read from Google Secret Manager into memory only when a call is made.
It is never printed, logged or written to disk.

  * runway = liquid EOS of the pool / EOS the pool actually spends per day, read from chain.
    DM at <= 30 days (early) and <= 7 days (urgent), repeated daily until fixed.
  * provider balance alerts (relayed by relay.py) are DMed, repeated daily while firing.
  * dead-man: a Slack-scheduled DM 30h ahead, pushed forward while the monitor runs, so it
    arrives only if this Mac or the relay stops checking.
"""
import datetime as dt
import json
import subprocess
import sys
import urllib.request
from zoneinfo import ZoneInfo

DANIEL = "U0CHQLXDT4K"
SECRET = ["/opt/homebrew/bin/gcloud", "secrets", "versions", "access", "latest",
          "--secret=buildflexity-slack-qa-bot-token", "--project=buildflexity-app"]
POOL = ("rsfui4ahy.gm", "fbrampay.gm", "rammgrtest11")
PAYER = POOL[0]
RPCS = ("https://jungle4.greymass.com", "https://jungle4.cryptolions.io")
HISTORY = "https://jungle4.cryptolions.io/v2/history/get_actions"
EARLY_DAYS, URGENT_DAYS = 30, 7
MIN_BURN = 25.0       # EOS/day, lowest 7-day average measured on 26 Nov 2026
FALLBACK_BURN = 55.0  # used until history has been read once: busiest 48h measured
REPEAT = 23.5 * 3600
DM_PREFIXES = ("payer-balance:", "payer-funding:", "balance-low:", "balance-funding:", "manage-failed:")
URGENT_PREFIXES = ("payer-balance:", "payer-funding:")
# The service re-logs a firing alert every 30 min. A restart forgets it without logging
# RESOLVED, so an alert silent for this long is over.
FIRING_WINDOW = 2 * 3600
DEADMAN_AHEAD, DEADMAN_EVERY = 30 * 3600, 6 * 3600
LISBON = ZoneInfo("Europe/Lisbon")


def log(message):
    print(f"{dt.datetime.now(LISBON):%F %T} {message}", file=sys.stderr, flush=True)


def get_json(url, body=None, headers=None):
    request = urllib.request.Request(
        url, data=None if body is None else json.dumps(body).encode(),
        headers={"User-Agent": "rp-alert-relay/1.0", "Content-Type": "application/json; charset=utf-8",
                 **(headers or {})})
    with urllib.request.urlopen(request, timeout=45) as response:
        return json.load(response)


def slack(method, payload):
    """One Slack Web API call. Errors carry only Slack's error code, never the token."""
    secret = subprocess.run(SECRET, capture_output=True, text=True, timeout=60)
    if secret.returncode or not secret.stdout.strip():
        raise RuntimeError(f"Slack token unreadable (gcloud exit {secret.returncode})")
    result = get_json(f"https://slack.com/api/{method}", payload,
                      {"Authorization": "Bearer " + secret.stdout.strip()})
    if not result.get("ok"):
        raise RuntimeError(f"Slack {method}: {result.get('error')}")
    return result


def send_dm(text):
    return slack("chat.postMessage", {"channel": DANIEL, "text": text, "unfurl_links": False})


def read_balances():
    error = None
    for rpc in RPCS:
        try:
            out = {}
            for name in POOL:
                account = get_json(f"{rpc}/v1/chain/get_account", {"account_name": name})
                out[name] = float(account.get("core_liquid_balance", "0 EOS").split()[0])
            return out
        except Exception as caught:  # noqa: BLE001 - try the next endpoint
            error = caught
    raise RuntimeError(f"chain unreadable ({type(error).__name__})")


def read_burn(now):
    """EOS/day leaving the pool to the system (fees, RAM): the higher of 48h and 7d averages."""
    averages = []
    for days in (2, 7):
        after = dt.datetime.fromtimestamp(now - days * 86400, dt.UTC).strftime("%Y-%m-%dT%H:%M:%S")
        spent = 0.0
        for name in POOL:
            for page in range(20):
                actions = get_json(f"{HISTORY}?account={name}&filter=eosio.token:transfer&after={after}"
                                   f"&limit=1000&skip={page * 1000}&sort=asc")["actions"]
                spent += sum(float(a["act"]["data"]["amount"]) for a in actions
                             if a["act"]["data"]["from"] == name
                             and a["act"]["data"]["to"].startswith("eosio."))
                if len(actions) < 1000:
                    break
        averages.append(spent / days)
    return max(*averages, MIN_BURN)


def runway_level(days):
    return 2 if days <= URGENT_DAYS else 1 if days <= EARLY_DAYS else 0


def quiet(now):
    hour = dt.datetime.fromtimestamp(now, LISBON).hour
    return hour >= 22 or hour < 8


def due(record, now, level):
    return now - record.get("at", 0) >= REPEAT or level > record.get("level", 0)


def check(state, provider_keys, now, io):
    """Decide and send. `io` supplies balances, burn, send, schedule, unschedule and fallback."""
    watch = state.setdefault("slack", {})
    sent = watch.setdefault("sent", {})
    lines, marks, urgent = [], {}, False

    try:
        balances = io["balances"]()
        watch["chain_failures"] = 0
    except Exception as error:  # noqa: BLE001
        log(str(error))
        balances = None
        watch["chain_failures"] = watch.get("chain_failures", 0) + 1
        if watch["chain_failures"] >= 12 and due(sent.get("chain", {}), now, 1):
            lines.append("• I have not been able to read Jungle 4 balances for an hour, so runway is unknown.")
            marks["chain"] = 1

    if balances is not None:
        if now - watch.get("burn_at", 0) >= 3600:
            try:
                watch["burn"], watch["burn_at"] = io["burn"](now), now
            except Exception as error:  # noqa: BLE001 - keep the last good figure
                log(f"history unreadable ({type(error).__name__})")
        burn = watch.get("burn", FALLBACK_BURN)
        pool = sum(balances.values())
        days = pool / burn
        watch["last"] = {"at": int(now), "pool": round(pool, 2), "burn": round(burn, 2),
                         "days": round(days, 1), "payer": balances.get(PAYER)}
        level = runway_level(days)
        if level == 0:
            if days > EARLY_DAYS * 1.1:  # hysteresis, so a wobbling estimate does not re-alert
                sent.pop("runway", None)
        elif due(sent.get("runway", {}), now, level):
            head = "URGENT, under 7 days" if level == 2 else "under 30 days"
            detail = ", ".join(f"{name} {value:,.0f}" for name, value in balances.items())
            lines.append(f"• Runway {head}: about *{days:.0f} days* left. {pool:,.0f} test EOS ({detail}) "
                         f"at about {burn:.0f} EOS/day.")
            marks["runway"] = level
            urgent = urgent or level == 2

    for key, entry in sorted(provider_keys.items()):
        if not key.startswith(DM_PREFIXES):
            continue
        firing = entry.get("active") and now - entry.get("last_seen", 0) < FIRING_WINDOW
        if not firing or not due(sent.get(key, {}), now, 1):
            continue
        lines.append(f"• Provider alert `{key}`: {entry.get('message', 'firing')}")
        marks[key] = 1
        urgent = urgent or key.startswith(URGENT_PREFIXES)

    if lines and (urgent or not quiet(now)):
        text = ("*Resource Provider (Jungle 4) is running low*\n" + "\n".join(lines)
                + "\nI will repeat this daily until it is fixed. Tracker: eha6tr.")
        try:
            io["send"](text)
            for key, level in marks.items():
                sent[key] = {"at": now, "level": level}
        except Exception as error:  # noqa: BLE001
            log(f"DM failed: {error}")
            if now - watch.get("fallback_at", 0) >= 6 * 3600:
                if io["fallback"](f"Resource Provider is low but the Slack DM failed ({error}). "
                                  + " ".join(lines)):
                    watch["fallback_at"] = now

    # Only push the dead-man forward while balances are really being read.
    if balances is not None and now - watch.get("deadman_at", 0) >= DEADMAN_EVERY:
        try:
            previous = watch.get("deadman_id")
            stamp = f"{dt.datetime.fromtimestamp(now, LISBON):%d %b %H:%M} Lisbon"
            watch["deadman_id"] = io["schedule"](
                int(now + DEADMAN_AHEAD),
                f"*Resource Provider balance monitor has stopped.* Last good check {stamp}. "
                "Low-balance alerts are not reaching you until the primary Mac relay "
                "(local.rp-alert-relay) is running again.")
            watch["deadman_at"] = now
            if previous:
                io["unschedule"](previous)
        except Exception as error:  # noqa: BLE001
            log(f"dead-man not refreshed: {error}")


def live_io(fallback):
    def schedule(post_at, text):
        return slack("chat.scheduleMessage", {"channel": DANIEL, "post_at": post_at, "text": text})[
            "scheduled_message_id"]

    def unschedule(message_id):
        slack("chat.deleteScheduledMessage", {"channel": DANIEL, "scheduled_message_id": message_id})

    return {"balances": read_balances, "burn": read_burn, "send": send_dm,
            "schedule": schedule, "unschedule": unschedule, "fallback": fallback}
