import datetime as dt
import unittest

import watch

NOON = dt.datetime(2026, 11, 26, 12, 0, tzinfo=watch.LISBON).timestamp()
NIGHT = dt.datetime(2026, 11, 26, 23, 0, tzinfo=watch.LISBON).timestamp()
HOUR = 3600


class Fake:
    def __init__(self, pool=5000.0, burn=50.0, fail_send=False):
        self.pool, self.rate, self.fail_send = pool, burn, fail_send
        self.sent, self.fallbacks, self.scheduled, self.deleted = [], [], [], []
        self.chain_down = False

    def balances(self):
        if self.chain_down:
            raise RuntimeError("chain unreadable")
        return {"rsfui4ahy.gm": self.pool, "fbrampay.gm": 0.0, "rammgrtest11": 0.0}

    def send(self, text):
        if self.fail_send:
            raise RuntimeError("Slack chat.postMessage: invalid_auth")
        self.sent.append(text)

    def schedule(self, at, text):
        self.scheduled.append(at)
        return f"Q{len(self.scheduled)}"

    def io(self):
        return {"balances": self.balances, "burn": lambda now: self.rate, "send": self.send,
                "schedule": self.schedule, "unschedule": self.deleted.append,
                "fallback": lambda m: self.fallbacks.append(m) or True}


def alert(key, now):
    return {key: {"active": True, "last_seen": now, "message": "low"}}


class WatchTest(unittest.TestCase):
    def test_healthy_is_silent(self):
        fake, state = Fake(), {}
        watch.check(state, {}, NOON, fake.io())
        self.assertEqual(fake.sent, [])

    def test_early_then_daily_then_urgent_then_fixed(self):
        fake, state = Fake(pool=1400), {}  # 28 days
        watch.check(state, {}, NOON, fake.io())
        watch.check(state, {}, NOON + HOUR, fake.io())
        self.assertEqual(len(fake.sent), 1)
        self.assertIn("under 30 days", fake.sent[0])
        watch.check(state, {}, NOON + 24 * HOUR, fake.io())
        self.assertEqual(len(fake.sent), 2)
        fake.pool = 300  # 6 days: escalates at once
        watch.check(state, {}, NOON + 25 * HOUR, fake.io())
        self.assertIn("URGENT", fake.sent[2])
        fake.pool = 9000
        watch.check(state, {}, NOON + 49 * HOUR, fake.io())
        self.assertEqual(len(fake.sent), 3)
        self.assertNotIn("runway", state["slack"]["sent"])

    def test_early_waits_for_morning_but_urgent_does_not(self):
        early, urgent = Fake(pool=1400), Fake(pool=300)
        watch.check({}, {}, NIGHT, early.io())
        watch.check({}, {}, NIGHT, urgent.io())
        self.assertEqual((len(early.sent), len(urgent.sent)), (0, 1))

    def test_provider_alerts_dm_daily_while_firing(self):
        fake, state = Fake(), {}
        keys = alert("balance-low:fbrampay.gm", NOON)
        watch.check(state, keys, NOON, fake.io())
        watch.check(state, keys, NOON + 300, fake.io())
        self.assertEqual(len(fake.sent), 1)
        keys = alert("balance-low:fbrampay.gm", NOON + 24 * HOUR)
        watch.check(state, keys, NOON + 24 * HOUR, fake.io())
        self.assertEqual(len(fake.sent), 2)
        keys["balance-low:fbrampay.gm"]["active"] = False
        watch.check(state, keys, NOON + 48 * HOUR, fake.io())
        self.assertEqual(len(fake.sent), 2)

    def test_alert_that_went_silent_without_resolved_is_not_repeated(self):
        fake, state = Fake(), {}
        keys = alert("balance-funding:config", NOON)
        watch.check(state, keys, NOON, fake.io())
        watch.check(state, keys, NOON + 24 * HOUR, fake.io())
        self.assertEqual(len(fake.sent), 1)

    def test_each_required_key_and_not_self_alerts(self):
        for prefix in watch.DM_PREFIXES:
            fake = Fake()
            watch.check({}, alert(prefix + "x", NOON), NOON, fake.io())
            self.assertEqual(len(fake.sent), 1, prefix)
        fake = Fake()
        watch.check({}, alert("self-stale", NOON), NOON, fake.io())
        self.assertEqual(fake.sent, [])

    def test_failed_dm_falls_back_to_tracker_and_retries(self):
        fake, state = Fake(pool=300, fail_send=True), {}
        watch.check(state, {}, NOON, fake.io())
        watch.check(state, {}, NOON + 300, fake.io())
        self.assertEqual(len(fake.fallbacks), 1)
        fake.fail_send = False
        watch.check(state, {}, NOON + 600, fake.io())
        self.assertEqual(len(fake.sent), 1)

    def test_deadman_rolls_forward_and_stops_when_chain_is_down(self):
        fake, state = Fake(), {}
        for hours in (0, 1, 6):
            watch.check(state, {}, NOON + hours * HOUR, fake.io())
        self.assertEqual((len(fake.scheduled), fake.deleted), (2, ["Q1"]))
        fake.chain_down = True
        for run in range(12):
            watch.check(state, {}, NOON + 24 * HOUR + run * 300, fake.io())
        self.assertEqual(len(fake.scheduled), 2)
        self.assertIn("not been able to read", fake.sent[-1])


if __name__ == "__main__":
    unittest.main()
