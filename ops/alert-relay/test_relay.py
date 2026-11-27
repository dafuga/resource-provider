import unittest

import coverage_notify
import relay

HOUR = 3600
T = 1_800_000_000  # a realistic epoch second


def line(kind, key, message="msg", at="2026-11-26T12:00:00+0000"):
    return f'{at} host rpcli[1]: {kind}: {message} {{"alert":"{key}","level":"error"}}'


class Box:
    def __init__(self, ok=True):
        self.ok, self.flags, self.notes = ok, [], []

    def flag(self, text):
        self.flags.append(text)
        return self.ok

    def note(self, text):
        self.notes.append(text)
        return self.ok


def feed(keys, box, now, *lines, pending=None):
    if pending is None:
        pending = {}
    relay.apply_lines(keys, lines, now, box.note, pending)
    relay.send_due(keys, now, box.flag)
    relay.send_critical(pending, lambda verb, item, message: (
        item == "eha6tr" and (box.flag if verb == "alert" else box.note)(message)
    ))


class RelayTest(unittest.TestCase):
    def test_lease_expiring_and_ram_cap_reach_the_inbox(self):
        keys, box = {}, Box()
        feed(keys, box, T, line("ALERT", "lease-expiring:fbrampay.gm"),
             line("ALERT", "ram-cap:pigracing.gm"))
        self.assertEqual(len(box.flags), 2)
        self.assertIn("lease-expiring:fbrampay.gm", box.flags[0])
        self.assertTrue(box.flags[1].startswith("[P1 player] "))
        self.assertIn("ram-cap:pigracing.gm", box.flags[1])

    def test_short_cpu_and_payer_outages_survive_one_batched_journal_read(self):
        keys, box = {}, Box()
        feed(keys, box, T, line("ALERT", "cpu-low:a.gm"), line("ALERT", "payer-dry:p.gm"),
             line("RESOLVED", "cpu-low:a.gm"), line("RESOLVED", "payer-dry:p.gm"))
        self.assertEqual(len(box.flags), 2)
        self.assertEqual(len(box.notes), 2)
        self.assertIn("cpu-low:a.gm", box.flags[0])
        self.assertIn("payer-dry:p.gm", box.flags[1])

    def test_repeated_log_lines_only_alert_once_per_episode(self):
        keys, box = {}, Box()
        both = (line("ALERT", "cpu-low:a.gm"), line("ALERT", "payer-dry:p.gm"))
        feed(keys, box, T, *both)
        feed(keys, box, T + 1800, *both)
        self.assertEqual(len(box.flags), 2)

    def test_new_ram_cap_episode_inside_six_hours_reaches_the_inbox(self):
        keys, box = {}, Box()
        feed(keys, box, T, line("ALERT", "ram-cap:pigracing.gm"))
        feed(keys, box, T + 300, line("RESOLVED", "ram-cap:pigracing.gm"))
        feed(keys, box, T + 600,
             line("ALERT", "ram-cap:pigracing.gm", at="2026-11-26T12:10:00+0000"))
        self.assertEqual((len(box.flags), len(box.notes)), (2, 1))
        self.assertNotEqual(box.flags[0], box.flags[1])

    def test_refused_critical_alert_and_recovery_retry_in_order(self):
        keys, box, pending = {}, Box(ok=False), {}
        feed(keys, box, T, line("ALERT", "cpu-low:a.gm"), line("RESOLVED", "cpu-low:a.gm"),
             pending=pending)
        self.assertEqual(len(box.flags), 1)
        self.assertEqual(box.notes, [])
        self.assertEqual(len(pending), 1)
        box.ok = True
        feed(keys, box, T + 300, pending=pending)
        self.assertEqual(len(box.flags), 2)
        self.assertEqual(len(box.notes), 1)
        self.assertEqual(pending, {})

    def test_refused_flag_is_retried_until_it_lands(self):
        keys, box = {}, Box(ok=False)
        feed(keys, box, T, line("ALERT", "lease-expiring:a.gm"))
        box.ok = True
        feed(keys, box, T + 300)
        feed(keys, box, T + 600)
        self.assertEqual(len(box.flags), 2)


def finding(key, immediate=True):
    return {"key": key, "message": f"problem {key}", "immediate": immediate}


class CoverageNotifyTest(unittest.TestCase):
    def run_step(self, state, now, box, *findings):
        coverage_notify.step(state, now, list(findings), box.flag, box.note)

    def test_flags_new_findings_once_then_every_six_hours_and_notes_recovery(self):
        state, box = {}, Box()
        self.run_step(state, 100_000, box, finding("unenrolled:a.gm"))
        self.run_step(state, 100_900, box, finding("unenrolled:a.gm"))
        self.assertEqual(len(box.flags), 1)
        self.run_step(state, 100_000 + 6 * HOUR, box, finding("unenrolled:a.gm"))
        self.assertEqual(len(box.flags), 2)
        self.run_step(state, 200_000, box)
        self.assertIn("unenrolled:a.gm", box.notes[0])

    def test_a_dip_needs_two_runs(self):
        state, box = {}, Box()
        self.run_step(state, 100_000, box, finding("cpu-floor:a.gm", False))
        self.run_step(state, 100_900, box)
        self.run_step(state, 101_800, box, finding("cpu-floor:a.gm", False))
        self.assertEqual(box.flags, [])
        self.run_step(state, 102_700, box, finding("cpu-floor:a.gm", False))
        self.assertEqual(len(box.flags), 1)

    def test_refused_flag_is_not_recorded_as_sent(self):
        state, box = {}, Box(ok=False)
        self.run_step(state, 100_000, box, finding("lease:a.gm:CPU"))
        self.assertEqual(state["sent"], {})

    def test_a_check_that_cannot_run_is_flagged_after_three_runs(self):
        state, box = {}, Box()
        for _ in range(4):
            coverage_notify.track_broken(state, "coverage check", "ssh exit 255", box.flag)
        self.assertEqual(len(box.flags), 1)

    def test_unknown_app_account_and_unreadable_repo(self):
        out = "UNKNOWN newacct.gm: dafuga/x:wrangler.toml\nscanned 1 files\n"
        findings, reason = coverage_notify.scan_findings(lambda *a: (1, out, ""))
        self.assertEqual([f["key"] for f in findings], ["app-config:newacct.gm"])
        findings, reason = coverage_notify.scan_findings(lambda *a: (2, "UNREADABLE x", ""))
        self.assertIsNone(findings)
        self.assertIn("UNREADABLE", reason)

    def test_unparseable_check_output_is_a_failure_not_a_pass(self):
        findings, reason = coverage_notify.coverage_findings(lambda *a: (0, "", "boom"))
        self.assertIsNone(findings)


if __name__ == "__main__":
    unittest.main()
