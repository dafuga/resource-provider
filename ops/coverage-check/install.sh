#!/bin/bash
# Installs the committed HEAD of this repo as the scheduled coverage check and the alert relay
# on the primary Mac (the only computer signed in to gcloud). Read-only against the provider
# and the chain. Rerun after merging inventory changes.
# Rollback: point ~/.local/share/rp-coverage/current at the previous release, and copy back
# the relay.py.before-<sha> backup printed below.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
sha="$(git -C "$repo" rev-parse --short=12 HEAD)"
root="$HOME/.local/share/rp-coverage"
release="$root/releases/$sha"
relay="$HOME/.local/share/rp-alert-relay"
mkdir -p "$release" "$HOME/.local/state/rp-coverage" "$relay"
git -C "$repo" archive HEAD | tar -x -C "$release"
(cd "$release" && "$HOME/.bun/bin/bun" install --frozen-lockfile --production >/dev/null)
echo "previous release: $(readlink "$root/current" || echo none)"
ln -sfn "$release" "$root/current"
for file in relay.py watch.py coverage_notify.py; do
	[ -f "$relay/$file" ] && cp -p "$relay/$file" "$relay/$file.before-$sha"
	cp "$release/ops/alert-relay/$file" "$relay/$file"
done
plist="$HOME/Library/LaunchAgents/local.rp-coverage-check.plist"
sed "s|__HOME__|$HOME|g" "$release/ops/coverage-check/local.rp-coverage-check.plist" >"$plist"
launchctl bootout "gui/$(id -u)/local.rp-coverage-check" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "installed $sha"
