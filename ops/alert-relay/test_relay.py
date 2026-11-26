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


def feed(keys, box, now, *lines):
    relay.apply_lines(keys, lines, now, box.note)
    relay.send_due(keys, now, box.flag)


class RelayTest(unittest.TestCase):
    def test_lease_expiring_and_ram_cap_are_delivered_at_once_in_one_flag(self):
        keys, box = {}, Box()
        feed(keys, box, T, line("ALERT", "lease-expiring:fbrampay.gm"),
             line("ALERT", "ram-cap:pigracing.gm"))
        self.assertEqual(len(box.flags), 1)
        self.assertIn("lease-expiring:fbrampay.gm", box.flags[0])
        self.assertIn("ram-cap:pigracing.gm", box.flags[0])

    def test_flapping_cpu_low_and_payer_dry_stay_quiet(self):
        keys, box = {}, Box()
        for i in range(6):
            now = T + i * 300
            feed(keys, box, now, line("ALERT", "cpu-low:a.gm"), line("ALERT", "payer-dry:p.gm"))
            feed(keys, box, now + 60, line("RESOLVED", "cpu-low:a.gm"),
                 line("RESOLVED", "payer-dry:p.gm"))
        self.assertEqual((box.flags, box.notes), ([], []))

    def test_persisting_cpu_low_and_payer_dry_are_delivered(self):
        keys, box = {}, Box()
        both = (line("ALERT", "cpu-low:a.gm"), line("ALERT", "payer-dry:p.gm"))
        feed(keys, box, T, *both)
        feed(keys, box, T + 300)
        self.assertEqual(box.flags, [])
        feed(keys, box, T + 1800, *both)
        self.assertEqual(len(box.flags), 1)
        self.assertIn("cpu-low:a.gm", box.flags[0])
        feed(keys, box, T + 2100, line("RESOLVED", "cpu-low:a.gm"))
        self.assertEqual(len(box.notes), 1)

    def test_flapping_ram_cap_is_flagged_at_most_every_six_hours(self):
        keys, box = {}, Box()
        for i in range(6):
            feed(keys, box, T + i * 600, line("ALERT", "ram-cap:pigracing.gm"))
            feed(keys, box, T + i * 600 + 300, line("RESOLVED", "ram-cap:pigracing.gm"))
        self.assertEqual((len(box.flags), len(box.notes)), (1, 1))
        feed(keys, box, T + 7 * HOUR, line("ALERT", "ram-cap:pigracing.gm"))
        self.assertEqual(len(box.flags), 2)

    def test_alert_forgotten_by_a_restart_is_not_delivered_as_persisting(self):
        keys, box = {}, Box()
        feed(keys, box, T, line("ALERT", "cpu-low:a.gm"))
        feed(keys, box, T + 3 * HOUR)
        self.assertEqual(box.flags, [])

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
