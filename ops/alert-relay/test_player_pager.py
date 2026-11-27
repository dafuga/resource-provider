from datetime import datetime, timezone
import unittest
from unittest.mock import patch

import player_pager as pager

T = datetime(2026, 11, 27, 2, tzinfo=timezone.utc).timestamp()
MESSAGE = "[P1 player] [resource-provider] 2026-11-27T02:00:00Z cpu-low:test.gm: CPU low"


def iso(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat()


def note(message, at):
    return {"text": message, "at": iso(at)}


def inbox(*notes, **overrides):
    return {"id": pager.PROVIDER, "notes_log": list(notes), **overrides}


class PlayerPagerTest(unittest.TestCase):
    def setUp(self):
        self.state = {"start": T - 60, "events": {}}
        self.calls = []

    def run_at(self, at, *, cos=True, reflag=True, dm="123.456"):
        def record(action, result):
            def send(*args):
                self.calls.append((action, args))
                return result
            return send

        return pager.process(self.state, lambda: at, record("cos", cos), record("tracker", reflag),
                             record("slack", dm), lambda: None)

    def incident(self):
        pager.ingest(self.state, [inbox(note(pager.ALERT_NOTE + MESSAGE, T + 300))])
        return next(iter(self.state["events"]))

    def test_night_p1_delivered_and_exact_event_ack_prevents_escalation(self):
        event = self.incident()
        self.assertTrue(self.run_at(T + 360))
        self.assertIn(f'tracker note {pager.PROVIDER} "P1 ACK {event}"', self.calls[0][1][0])
        pager.ingest(self.state, [inbox(note(f"P1 ACK {event}", T + 400))])
        self.assertTrue(self.run_at(T + pager.ACK_SECONDS))
        self.assertEqual([action for action, _ in self.calls], ["cos"])

    def test_unacknowledged_even_after_transport_reflags_and_dms_at_deadline(self):
        event = self.incident()
        paged_at = T + 360
        self.run_at(paged_at)
        self.run_at(paged_at + pager.ACK_SECONDS - 1)
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(self.run_at(paged_at + pager.ACK_SECONDS))
        self.run_at(paged_at + pager.ACK_SECONDS + 60)
        self.assertEqual([action for action, _ in self.calls], ["cos", "tracker", "slack"])
        self.assertEqual(self.state["events"][event]["slack_receipt"], "123.456")

    def test_a_failed_daytime_leg_retries_and_late_ack_keeps_the_sla_miss(self):
        daytime = T + 10 * 3600
        message = MESSAGE.replace("02:00:00Z", "12:00:00Z")
        pager.ingest(self.state, [inbox(note(pager.ALERT_NOTE + message, daytime))])
        event = next(iter(self.state["events"]))
        self.assertTrue(self.run_at(daytime))
        self.assertFalse(self.run_at(daytime + pager.ACK_SECONDS, dm=False))
        pager.ingest(self.state, [inbox(note(f"P1 ACK {event}", daytime + pager.ACK_SECONDS + 1))])
        self.assertTrue(self.run_at(daytime + pager.ACK_SECONDS + 60))
        self.assertEqual([action for action, _ in self.calls], ["cos", "tracker", "slack", "slack"])

    def test_multiple_occurrences_one_inbox_and_ignores_generated_escalations(self):
        event = self.incident()
        pager.ingest(self.state, [inbox(
            note(pager.ALERT_NOTE + MESSAGE, T + 320),
            note(pager.ALERT_NOTE + MESSAGE.replace("02:00:00", "02:01:00"), T + 350),
            note(pager.ALERT_NOTE + pager.ESCALATION, T + 360),
            note(f"P1 ACK {event}", T + 370),
        )])
        self.run_at(T + 400)
        self.assertEqual(len(self.state["events"]), 2)
        self.assertEqual(len(self.calls), 1)
        self.assertNotIn(f"P1 ACK {event}", self.calls[0][1][0])

    def test_legacy_frontier_and_keeper_alerts_without_paging_other_flags(self):
        sample = {"needs_daniel": True, "updated_at": iso(T + 10)}
        pager.ingest(self.state, [
            dict(sample, id="jsx1zsn228", question="Production Frontier Build Settlement probe/page failure {}"),
            dict(sample, id="abcdefghij", owner="rng-keeper-watch",
                 question="RNG poker keeper failing after 3 checks"),
            dict(sample, id="0123456789", question="Approve production deploy?"),
            dict(sample, id="9876543210", question=MESSAGE, sensitive=True),
        ])
        self.assertEqual(len(self.state["events"]), 2)

    def test_slack_page_uses_only_the_expected_bot_and_existing_dm(self):
        identity = {"bot_id": pager.SLACK_BOT, "team_id": pager.SLACK_WORKSPACE}
        with patch.object(pager.watch, "slack") as slack, patch.object(pager.watch, "dm_channel") as dm:
            slack.return_value = {"bot_id": "other-bot", "team_id": pager.SLACK_WORKSPACE}
            with self.assertRaisesRegex(RuntimeError, "Slack bot or workspace mismatch"):
                pager.send_slack_page("test")
            dm.assert_not_called()
            slack.return_value = identity
            dm.return_value = "other-channel"
            with self.assertRaisesRegex(RuntimeError, "Slack DM mismatch"):
                pager.send_slack_page("test")
            self.assertEqual([call.args[0] for call in slack.call_args_list], ["auth.test", "auth.test"])

            dm.return_value = pager.SLACK_DM
            slack.side_effect = [identity, {"channel": pager.SLACK_DM, "ts": "100.200"}]
            self.assertEqual(pager.send_slack_page("test"), "100.200")
            self.assertEqual(slack.call_args.args, ("chat.postMessage", {
                "channel": pager.SLACK_DM, "text": "test", "unfurl_links": False,
            }))

    def test_replay_suppresses_three_resolved_episodes_and_gives_open_incident_full_ack_window(self):
        activation = datetime(2026, 11, 27, 15, 55, tzinfo=timezone.utc).timestamp()
        self.state["activation_at"] = activation
        self.state["start"] = activation - 86400
        replayed = (
            ("payer-dry:rsfui4ahy.gm", "05:22:20.114", "05:22:30.057"),
            ("ram-cap:pigracing.gm", "07:31:40.624", "07:58:31.024"),
            ("cpu-low:rngfront.gm", "11:54:40.481", "11:57:40.391"),
        )
        notes = []
        for key, fired, recovered in replayed:
            notes.extend((
                note(f"[resource-provider] RESOLVED 2026-11-27T{recovered}Z: cleared (key {key})",
                     activation - 60),
                note(f"{pager.ALERT_NOTE}[P1 player] [resource-provider] 2026-11-27T{fired}Z {key}: fired",
                     activation + 5),
            ))
        # An earlier recovery for the same key cannot clear this later episode.
        notes.append(note(f"{pager.ALERT_NOTE}[P1 player] [resource-provider] "
                          "2026-11-27T15:53:00Z ram-cap:pigracing.gm: still active", activation - 120))
        notes.append(note(f"{pager.ALERT_NOTE}[P1 player] old unverified event", activation - 60))
        pager.ingest(self.state, [inbox(*notes)])
        self.assertTrue(self.run_at(activation + 10))
        self.assertEqual([action for action, _ in self.calls], ["cos"])
        event = next(iter(self.state["events"]))
        self.assertIn("ram-cap:pigracing.gm", self.calls[0][1][0])
        self.assertTrue(self.run_at(activation + 909))
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(self.run_at(activation + 910))
        self.assertEqual([action for action, _ in self.calls], ["cos", "tracker", "slack"])

    def test_recovery_arriving_after_page_cancels_pending_escalation(self):
        self.incident()
        self.assertTrue(self.run_at(T + 310))
        pager.ingest(self.state, [inbox(
            note(pager.ALERT_NOTE + MESSAGE, T + 300),
            note("[resource-provider] RESOLVED 2026-11-27T02:06:00Z: cleared (key cpu-low:test.gm)", T + 360),
        )])
        self.assertTrue(self.run_at(T + 2000))
        self.assertEqual([action for action, _ in self.calls], ["cos"])
