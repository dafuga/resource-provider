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

class FrontierVantageTest(unittest.TestCase):
    def test_recorded_overload_is_checked_and_warns_only_cos_until_confirmed(self):
        payload = {"time": iso(T), "stage": "release_metadata", "durationMs": 8003,
                   "quoteRequestSent": False, "signRequestSent": False, "errorClass": "timeout",
                   "hostLoad": {"load1": 38.99, "load5": 45.19, "load15": 41.61, "cpus": 10}}
        message = "Production Frontier Build Settlement probe/page failure " + pager.json.dumps(payload)
        state = {"start": T - 60, "events": {}}
        pager.ingest(state, [inbox(note(pager.ALERT_NOTE + message, T), id="jsx1zsn228")])
        event = next(iter(state["events"].values()))
        messages, escalations = [], []
        def run(now):
            def cos(message):
                messages.append(message)
                return True
            return pager.process(state, lambda: now, cos, lambda _, msg: escalations.append(msg) or True,
                                 lambda msg: escalations.append(msg) or "123.456", lambda: None)
        with patch.object(pager, "frontier_read", return_value=("healthy", "HTTP 200")) as read:
            self.assertTrue(run(T))
            self.assertTrue(run(T + 960))
            self.assertEqual(read.call_args.args[0], "release")
        self.assertEqual(len(messages), 1)
        self.assertIn("monitor health", messages[0].lower())
        self.assertIn("38.99", messages[0])
        self.assertIn("HTTP 200", messages[0])
        self.assertNotIn("cos_at", event)
        self.assertFalse(escalations)
        with patch.object(pager, "frontier_read", return_value=("failed", "HTTP 503")):
            self.assertTrue(run(T + 1020))
        self.assertIn("P1 PROD PLAYER ALERT", messages[-1])
        self.assertIn("HTTP 503", messages[-1])
        self.assertEqual(event["cos_at"], T + 1020)
        run(T + 1020 + pager.ACK_SECONDS)
        self.assertEqual(len(escalations), 2)
        self.assertTrue(all("HTTP 503" in message and "38.99" in message for message in escalations))

    def test_indeterminate_peer_never_confirms_a_timeout_but_explicit_sign_denial_still_pages(self):
        cases = [("probe/page", {"stage": "load", "errorClass": "timeout"}, False),
                 ("quote", {"stage": "quote", "errorClass": "timeout"}, False),
                 ("sign", {"stage": "sign", "status": 503}, True),
                 ("heartbeat", {"reason": "missed_runs"}, False),
                 ("budget", {"reasons": ["headroom.actor.ramUnits"]}, False),
                 ("budget", {"reasons": ["sponsor_budget_exhausted"]}, True)]
        for channel, payload, p1 in cases:
            with self.subTest(channel=channel, payload=payload):
                state = {"start": T, "events": {}}
                message = f"Production Frontier Build Settlement {channel} failure " + pager.json.dumps(payload)
                pager.ingest(state, [inbox(note(pager.ALERT_NOTE + message, T), id="jsx1zsn228")])
                sent = []
                with patch.object(pager, "frontier_read", return_value=("unknown", "unreachable")):
                    pager.process(state, lambda: T, lambda msg: sent.append(msg) or True,
                                  self.fail, self.fail, lambda: None)
                self.assertEqual("P1 PROD PLAYER ALERT" in sent[0], p1)
                self.assertIn("unreachable", sent[0])

    def test_primary_http_observer_reads_content_and_distinguishes_failure_from_access_errors(self):
        import threading
        from http.server import BaseHTTPRequestHandler, HTTPServer

        class Response(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(self.server.status)
                self.end_headers()
                self.wfile.write(self.server.body)

            def log_message(self, *unused):
                pass

        with HTTPServer(("127.0.0.1", 0), Response) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with patch.dict(pager.FRONTIER_URLS, release=f"http://127.0.0.1:{server.server_port}/version.json"):
                    server.body = pager.json.dumps({"commit": "a" * 40, "chainId": pager.CHAIN,
                                                    "resourceProviderUrl": pager.SPONSOR_ORIGIN}).encode()
                    for server.status, expected in [(200, "healthy"), (503, "failed"), (403, "unknown")]:
                        self.assertEqual(pager.frontier_read("release")[0], expected)
                    server.status, server.body = 200, b"<html>fallback</html>"
                    self.assertEqual(pager.frontier_read("release")[0], "failed")
            finally:
                server.shutdown()
                thread.join()

    def test_two_network_deadlines_need_working_primary_egress_and_capacity(self):
        with patch.object(pager.os, "getloadavg", return_value=(0, 0, 0)):
            for control, expected in [((0, 200, b""), "failed"), ((28, 0, b""), "unknown")]:
                with patch.object(pager, "public_get", side_effect=[(28, 0, b""), control]):
                    self.assertEqual(pager.frontier_read("release")[0], expected)
        with patch.object(pager.os, "getloadavg", return_value=(10000, 10000, 10000)), \
                patch.object(pager, "public_get", return_value=(28, 0, b"")) as request:
            self.assertEqual(pager.frontier_read("release")[0], "unknown")
            self.assertEqual(request.call_count, 1)

    def test_initial_confirmed_outage_and_tracker_receipt_retry_share_the_existing_paging_clock(self):
        message = 'Production Frontier Build Settlement probe/page failure {"errorClass":"timeout","stage":"load"}'
        state = {"start": T, "events": {}}
        pager.ingest(state, [inbox(note(pager.ALERT_NOTE + message, T), id="jsx1zsn228")])
        sent, notes = [], []
        def record(_, evidence):
            notes.append(evidence)
            return len(notes) > 1
        for now in (T, T + 60):
            with patch.object(pager, "frontier_read", return_value=("failed", "HTTP 503")):
                pager.process(state, lambda: now, lambda msg: sent.append(msg) or True, self.fail,
                              self.fail, lambda: None, record)
        self.assertEqual(len(sent), 1)
        self.assertEqual(next(iter(state["events"].values()))["cos_at"], T)
        self.assertEqual(len(notes), 2)
        self.assertIn("HTTP 503", notes[-1])
        self.assertIn("p1 evidence", notes[-1])
