# Production player alerts

CoS acknowledges each production player-path monitor page on Tracker within
15 minutes of delivery to CoS, at any hour. The pager sends an immediate P1 prompt containing the
event ID, the source Tracker item, and the exact acknowledgement command.
Run the command as soon as receipt is confirmed, then triage the incident.
A successful tmux send, a generic Tracker answer, or a recovery note does not
count as acknowledgement. Keep the regular night restrictions for other work.

The pager reads production Frontier outage and budget inboxes, the Resource
Provider inbox, and keeper alerts. Other production player monitors can use
`tracker alert <item> "[P1 player] <unique event timestamp and summary>"`.
A note stays readable after the source posts a recovery or a different alert.
Legacy flags can still be read while their question is active. Producers should
use the note form if questions can be replaced or closed between polls.

The provider relay publishes new `cpu-low`, `payer-dry`, and `ram-cap` episodes to
`eha6tr` at the next journal poll. The relay records a full episode found in one
journal batch as audit and recovery notes. A repeat of an open episode is
suppressed. The pager matches recovery notes to the source key and occurrence
time, and cancels any pending escalation when the incident is resolved. On
activation, it admits new alerts, unpaired Provider episodes in the retained
Tracker history, and active monitor questions. Unverified older notes are
excluded.

The pager polls every minute. It starts the deadline after a successful page
to CoS. At the first poll at or after the deadline it
records a fresh escalation with `tracker alert` on the same item and posts to
Daniel's existing DM with dafuga's bot. Each leg retries independently and successful deliveries
are recorded under `~/.local/state/player-pager.json`. Slack acceptance establishes
a delivery receipt. CoS acknowledgement is recorded separately on Tracker.

## Activation on the primary Mac

The Slack leg uses the existing dafuga's bot integration, app `A0CM7UBDKP0`.
Its token remains in Secret Manager, project `buildflexity-app`, secret
`dafugas-bot-slack-token`. The pager uses the Resource Provider's Slack
helper to check the bot and workspace, open the established conversation
with Daniel, and verify that the post response names the same DM
(`D0CN4BTE5TJ`). Use the installed bot-enabled `watch.py` that matches this
release. Preserve the running provider's Slack and dead-man state.

After approval, compare the installed relay to the release and preserve a
timestamped copy of `relay.py` and its journal state. Install only the reviewed
`relay.py` and `player_pager.py` in `~/.local/share/rp-alert-relay`, preserving the
installed `watch.py` and `coverage_notify.py`. Check the pager with
`player_pager.py --dry-run`, substitute the local home for `__HOME__` in
`local.rng-player-pager.plist`, lint the resulting plist, and bootstrap it under
`gui/$(id -u)`. The established `local.rp-alert-relay` job reads the new relay
on its next normal tick. Verify hashes, both scheduled exit statuses, and the
journal watermark. Roll back by booting out `local.rng-player-pager` and
atomically restoring the saved `relay.py`. Retain current relay state so
restoring code cannot resurrect old provider Slack dead-man receipts.

Keep the Tracker task open until real Provider and Frontier alerts show the
required receipts. A labeled rehearsal can verify plumbing without describing
it as a real outage or forcing a production resource failure.

Before activating or changing replay behavior, replay a startup backlog
containing resolved and unresolved episodes and verify both the live journal
and Tracker boundaries without sending pages. The verifier should confirm
the resolved backlog produces no page and any eligible late-arriving event
gets a full acknowledgement window from its first successful page.
