# RP503 investigation

## Result

**The reported 503-on-success defect is not reproduced in this repository. No runtime fix is claimed.**

The reported Fatebound revision calls its own same-origin sponsorship endpoint,
not this Resource Provider service. That client deliberately continues with the
original transaction after an ordinary non-200 sponsorship response. A failed
sponsorship request can therefore be followed by a successful, self-funded chain
transaction. This is a source-supported explanation of the observed combination,
not proof of which particular dependency failed during the playthrough.

The specific playthrough failure remains unattributed because no failed URL,
response body or transaction correlation was captured. The follow-up record at
`~/fb-briefs/fb-merge-unlock-status.md:97` and `:99` says two 503s occurred during
13:46–13:57 Lisbon/UTC. The campaign was still a preview; `:105` records its paid
unlock at 14:10:19. The note establishes the observation, not its HTTP origin or
underlying exception. No incident-specific root cause is claimed.

A separate, reproducible Fatebound defect was found: paid and legacy campaigns
unnecessarily depend on free-quota RPC reads. The proposed fix and its tests are
in [PROPOSED-FATEBOUND-503.patch](PROPOSED-FATEBOUND-503.patch), based on `95174e0`.
It was tested only in a temporary source snapshot. **It does not explain the two
preview-phase errors in the note.** No Fatebound worktree was edited or committed.

## Revisions and scope

- Resource Provider starting revision: `f98ff6df78e2c72082749bb1173439d2c866c130`.
- Branch: `fix/rp-spurious-503`, based on the local
  `dafuga/fix-billable-powerup-minimum` branch.
- Fatebound source inspected at the exact reported commit:
  `95174e05742311820500528a46d0a9a2faa2c850`, using `git show` without changing
  its worktrees.
- This RP worktree changes only API characterization tests, this report and the
  proposed Fatebound patch artifact. No RP `src/` runtime file changes.
- Draft PR: [dafuga/resource-provider #3](https://github.com/dafuga/resource-provider/pull/3),
  open and draft, targeting `dev` (`7dfaddfa28aceb059652b8d777ad823fb452ac18`).
- Verified code/test commit: `3516c602b7e75ce6f9fdc7936e0fa51bd4b27c1b`.
  The follow-up commit only records this PR link and final evidence notes.
- Pushed only `fix/rp-spurious-503` to `dafuga`; no primary/environment branch
  was changed. The draft retains the supplied branch ancestry, including
  `17a693d`, `fb2a10d` and `f98ff6d`, relative to `dev`.

The brief's PR/deployment premise is stale. Read-only GitHub inspection on
2026-11-15 found [dafuga/resource-provider PR #2](https://github.com/dafuga/resource-provider/pull/2)
open on `fix/oracle-signer-cpu`, head
`579604dfa5c17a0d207f0b58a9c30503a48dd43d`, targeting `dev`. It is not the
starting branch of this worktree. Its description also identifies a different
deployed baseline. None of that establishes the current VM revision: the VM was
not accessed. Do not treat this draft as based on verified live code.

## Root-cause trace

All Fatebound references below are relative to `rng-fatebound` at `95174e0`,
not its current main branch.

| Finding                                                                                                                              | Source                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Fatebound configures its provider endpoint as `${window.location.origin}/api`.                                                       | `src/lib/state/wharf.svelte.ts:153`, `:157`                                       |
| The plugin POSTs to that endpoint plus `/v1/resource_provider/request_transaction`.                                                  | `src/lib/state/resourceProviderPlugin.ts:50`                                      |
| An ordinary non-200 response sets `self-funded` and returns the original request without provider signatures.                        | `src/lib/state/resourceProviderPlugin.ts:60`                                      |
| The wallet subsequently runs `session.transact`; success is recorded separately.                                                     | `src/lib/state/wharf.svelte.ts:649`, `:654`                                       |
| Fatebound's own route maps unexpected errors to HTTP 503, `Resource provider is temporarily unavailable`.                            | `src/routes/api/v1/resource_provider/request_transaction/+server.ts:35`, `:38`    |
| Other explicit 503 reasons include missing provider configuration, failed sponsorship allowance reads, and unavailable contract ABI. | `src/lib/server/resource-provider.ts:71`, `:195`, `:296`                          |
| RAM funding has a distinct 503 with `code: ram-unavailable`, which the client treats as a hard stop rather than ordinary fallback.   | `src/lib/server/resource-ram.ts:33`; `src/lib/state/resourceProviderPlugin.ts:59` |

### Every Fatebound 503 path

| Route response body                                               | Trigger at `95174e0`                                                                                                                                                                                                                                                                                                                                                                              | Client behavior                                                                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `error: Resource provider is not configured`                      | Missing provider signing key at `src/lib/server/resource-provider.ts:69`; thrown at `:71`, propagated by the route's typed-error branch `+server.ts:32`.                                                                                                                                                                                                                                          | Returns the original request without sponsor signatures, `self-funded`.                                                         |
| `error: Unable to verify sponsorship allowance`                   | Any non-2xx `get_table_rows` result in `resource-provider.ts:175`, thrown at `:195`. This includes `advaccess`, `adventures`, `sponsoruse`, `sponsorcfg`, maintenance campaign reads and pending `rngintents` reads.                                                                                                                                                                              | Same ordinary fallback.                                                                                                         |
| `error: Fatebound contract ABI is unavailable`                    | `get_abi` succeeds but contains no ABI at `resource-provider.ts:294`, `:296`.                                                                                                                                                                                                                                                                                                                     | Same ordinary fallback.                                                                                                         |
| `error: Resource provider is temporarily unavailable`             | The route's catch-all `+server.ts:35`–`:38`: transport rejection, non-success ABI API response, invalid RPC JSON/ABI, unexpected decode/serialization failure, invalid configured signing key, or another unexpected exception. RPC JSON parsing is not retried in these helpers.                                                                                                                 | Same ordinary fallback.                                                                                                         |
| `error: Game RAM funding is unavailable`, `code: ram-unavailable` | `prepareRamPurchase` in `resource-ram.ts:93`: unsafe/missing RAM configuration, invalid player/payer account data, unavailable RAM/payer/balance RPCs, payer authority/resources/balance, malformed market/quote, or an unaffordable capped top-up. These become `RamFundingUnavailable` at `:33`, including caught exceptions at `:166`. Route branch `+server.ts:30` preserves its status/code. | Throws `GameResourceError` before signing; this branch does **not** explain ordinary fallback followed by a landed transaction. |

The signer/request validation branches return 400-class refusals, and exhausted
free quota returns 429, not 503. An ordinary 429 also permits client fallback.
A network exception during the sponsor fetch or unreadable response JSON follows
the plugin's `unavailable` fallback rather than proving a chain submission failed.

### All external calls; no standalone RP hop

`provideGameplayResources` creates an Antelope API client from
`dependencies.apiEndpoint || privateEnv('ANTELOPE_API_ENDPOINT') || API_ENDPOINT`
at `resource-provider.ts:292`. That is a **chain RPC endpoint**, not an RP URL.
The configured value was not read. The tracked Jungle4 default in
`src/lib/config/public-chain-config.ts:27` is `https://jungle4.api.eosnation.io`.

The helper calls only:

1. `get_abi(CONTRACT_ACCOUNT)` at `resource-provider.ts:294`.
2. `get_table_rows` for campaign/access/quota data (`:175`, `:212`), with extra
   `rngintents` lookup for settlement/cancellation or campaign lookup for RAM
   compaction (`:327`, `:328`).
3. Optional RAM checks: player `get_account` at `resource-ram.ts:126`; then
   payer `get_account`, `rammarket` via `get_table_rows`, and payer
   `get_currency_balance` at `:134`, `:135`, `:139`.

`privateEnv` is an environment lookup (`src/lib/server/cloudflare-ai.ts:29`),
not an AI call. Despite that module's name, this path invokes no AI service.
`prepareRamPurchase` only returns a proposed purchase; `buyram` is appended to
the unsigned transaction at `resource-provider.ts:385` and is not sent here.
The provider signs locally at `:411` and returns at `:418`. There is no call to
the standalone Resource Provider API, push/send, finality, receipt lookup,
duplicate handling or on-chain retry in this route. The plugin also reads ABI
and transaction headers from the chain before contacting its same-origin route.

The landed transaction is sent later by the wallet/session. Its success does
not retroactively make a failed sponsorship preparation successful. Converting
these real failures to HTTP 200 without a valid safe signature would be wrong.

### Proposed Fatebound patch and red-green evidence

At `resource-provider.ts:212`, a single `Promise.all` fetches access, campaign,
free usage and free configuration. The paid/legacy early returns at `:240` and
`:241` happen only after all four succeed. Thus a quota-table outage rejects
uncapped paid/legacy sponsorship with 503 even when the required campaign/access
reads are healthy. The sponsorship spec explicitly exempts those campaigns from
free quota. That is a demonstrated dependency bug, independent of the historical
preview incident.

`PROPOSED-FATEBOUND-503.patch` moves the quota reads after the paid/legacy early
returns. Campaign existence and access validation stay mandatory. Free campaigns
still require both quota reads, genuine quota RPC failures remain 503, exhausted
quota remains 429, and RAM funding errors retain their signing-stop code.
Tradeoff: quota-limited campaigns now wait for campaign/access reads before
starting quota reads, adding a read round trip. No timeout or RPC retry policy
is introduced. This remains a reviewable proposal, not an incident repair.
The patch includes a specification amendment and tests in:

- `src/lib/server/resource-provider.test.ts`: four paid/legacy outage regressions
  plus two genuine free-quota failure cases; validates the returned signatures.
- `src/lib/state/resourceProviderPlugin.test.ts`: ordinary 503 preserves the
  original request with no sponsor signatures and sets `self-funded`.
- `src/routes/api/v1/resource_provider/request_transaction/request-transaction.test.ts`:
  typed 503 response branches and the generic unexpected-error 503, alongside
  existing RAM-stop and request-validation tests.

Only a temporary source snapshot was changed, extracted with `git show` from
`95174e0`. It used the existing installed dependencies from the matching
`rng-fatebound-sol-loader` worktree read-only. Its own module links, Vite cache,
test config and files live in a task-owned temporary directory; no `.env` file
was copied or loaded, and its global fetch rejects live network access.

- Original selected suites: **26 pass** across the helper, route and plugin files.
- New tests against original runtime: **4 fail, 33 pass**. All four failures are
  `keeps paid/legacy coverage independent of unavailable sponsoruse/sponsorcfg`,
  throwing `Unable to verify sponsorship allowance` from `tableRows:195` via
  `preflightSponsorship:212`.
- Same unchanged tests with the proposed runtime: **37 pass, 0 fail** across
  three files. Test SHA-256 hashes were compared between red and green.
- `git apply --check` succeeds against pristine `95174e0` copies. The patch is
  not applied to any Fatebound worktree.
- Patch SHA-256: `7a7781c17442efd982fbee3df39512e9ad07bba01e13c7abe7d98cdcf264e8c4`.
- Logs: `/tmp/rp503-fatebound-baseline.log`, `/tmp/rp503-fatebound-red.log`,
  `/tmp/rp503-fatebound-green.log`. The temporary snapshot path is stored in
  `/tmp/rp503-fatebound-review-path.txt`.
- Command in that snapshot:
  `node /Users/danielfugere/projects/rng-fatebound-sol-loader/node_modules/vitest/vitest.mjs run --config vitest.review.config.ts`,
  with Node 22, a sanitized environment, Node test environment and one unit worker.
- This is focused mock-based verification of a proposed patch, not the full
  Fatebound suite, browser E2E, live playthrough, build, typecheck or deployment.
  No real transaction was sent.

The exact preview failure remains one of the table's candidates until its body
or server exception is captured. The note's early-preview timing specifically
rules out claiming that the paid/legacy optimization fixes that incident.

In this Resource Provider checkout:

- `src/api/v1/request.ts:76` processes cosigning. It resolves the transaction,
  estimates resources at `:99`, signs at `:111` or `:164`, and returns the
  modified transaction and signatures at `:123` or `:172`.
- `src/lib/wharf/estimation.ts:66` invokes `compute_transaction` five times for
  estimation. These are not calls to `push_transaction` or `send_transaction`.
- `src/lib/wharf/session/index.ts:51` signs a digest locally and returns the
  signature; it does not broadcast.
- `src/api/v1/request.ts:209` retries stale ABI errors by invalidating the ABI
  cache and repeating cosigning, not by resubmitting a landed transaction.
- `src/api/v2/lightaccount/request.ts:132` also only signs and returns a
  transaction. The v2 provider request handler is unimplemented at
  `src/api/v2/provider/index.ts:18`.
- There is no explicit HTTP 503 response in `src/`. The assembled app's error
  handler is `src/lib/http.ts:70`. Injected upstream 503s produce HTTP 500
  errors in this version, without signatures.
- The active chain-write calls elsewhere in the repo are manager and
  self-management jobs, not the cosigning request handler. The old v1 powerup
  endpoint is commented out and not registered.

No post-push finality wait, duplicate-broadcast retry, second-node broadcast or
receipt-lookup path exists in these sponsored-transaction handlers. There is no
safe basis to add duplicate-success recovery or convert a genuine sponsorship
failure to success here.

## Local logs

No root-level logs exist in this worktree. The canonical sibling checkout has
`info.log` and `error.log`; timestamp and keyword inspection found:

- `info.log`: 136 lines, ending 2026-07-10T18:48:14.005Z.
- `error.log`: one line, dated 2026-05-01T23:09:43.237Z.
- Neither contains November 15 entries, literal 503s or duplicate/submission
  diagnostics.

No log contents containing configuration or credentials were printed. No VM
logs were accessed. Public-chain queries were unnecessary: observing a landed
transaction alone would not prove that this service sponsored it.

## Changes and verification

`test/v1.test.ts` now characterizes the actual API boundary:

1. A valid cosigning request returns HTTP 200, a transaction and one signature.
   Its outbound calls are restricted to the account, header, ABI and estimation
   RPCs; broadcasting or receipt/finality requests fail the assertion.
2. A synthetic HTTP 503 from `get_account` remains an error and returns no
   signatures or broadcast.
3. A synthetic HTTP 503 from `compute_transaction` remains an error and returns
   no signatures or broadcast.

All external fetches delegate to the existing recorded-fixture fetch, with
recording disabled by the sanitized test environment. Only the synthetic testing
database is used. The tests run through the assembled Elysia app with
`app.handle`; no live chain transaction is sent.

### Resource Provider red then green

**No faithful RP red result was obtained for the reported defect.** These are
characterization tests and pass against unchanged runtime code. The initial
test-authoring failures came from incorrect assumptions about the assembled
app's error response shape, not a reproduced 503-on-success defect; they are
not counted as red regression evidence. No assertion was weakened to claim a
product repair, and no synthetic bug was introduced to manufacture red.

### Commands and results

Commands below ran on the primary Mac. The test commands were executed with a
sanitized environment, retaining only `PATH`, `HOME`, and `TMPDIR` before Bun
loads the checked-in synthetic `test/.env.test`.

| Check                                                               | Result                                                                                                                                                           |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`                                     | Initial default Node 26 native-addon build failed; retry with the installed Node 22 first on PATH succeeded, with no lockfile changes.                           |
| Baseline `bun --env-file=./test/.env.test test`                     | 24 pass, 0 fail, 3 files.                                                                                                                                        |
| Final `bun --env-file=./test/.env.test test`                        | 26 pass, 0 fail, 3 files.                                                                                                                                        |
| `bun run lint`                                                      | Fails at Prettier on the existing, untracked `BRIEF-503.md`; the supplied brief was preserved.                                                                   |
| Baseline `bun run eslint`                                           | Six formatting errors in the supplied brief and two existing import-order errors (`src/lib/db/index.ts:1`, `test/v1.test.ts:1`).                                 |
| Final lint                                                          | Fails with seven existing errors: six in the supplied brief and one import-order error in src/lib/db/index.ts. Changed test/report lint and formatting pass.     |
| `tsc --noEmit --tsBuildInfoFile /tmp/rp503-final.tsbuildinfo`       | Fails with the same nine pre-existing diagnostics as the starting revision; baseline and final output are byte-identical. No new diagnostic in the changed test. |
| `bun build src/index.ts --compile --outfile /tmp/rp503-build/rpcli` | Passes. The compiled binary was not executed or deployed.                                                                                                        |
| Source/report whitespace check                                      | Passes.                                                                                                                                                          |

The source/report whitespace command is
`git diff --check HEAD^ HEAD -- . ":(exclude)PROPOSED-FATEBOUND-503.patch"`.
A full staged whitespace check flags the embedded unified diff's context-line
spaces/tabs and empty context lines. Those are necessary patch syntax, preserved
for review; the separate `git apply --check` against pristine Fatebound files
passes. This is not a passing full-repo lint claim.

The nine typecheck diagnostics are at
`src/api/v2/lightaccount/request.ts:94`, `src/cli/manager/setup.ts:112`,
`src/cli/provider/setup.ts:63` and `:167`, `src/lib/env.ts:1`,
`src/provider/validate.ts:49`, `test/mock-fetch.ts:20` and `:47`, and
`test/powerup.test.ts:116`. They were captured before modifying tests.

Raw command logs remain outside Git in `/tmp/rp503-baseline-tests.log`,
`/tmp/rp503-final-tests.log`, `/tmp/rp503-baseline-lint.log`,
`/tmp/rp503-baseline-eslint.log`, `/tmp/rp503-baseline-typecheck.log`,
`/tmp/rp503-final-typecheck.log` and `/tmp/rp503-build.log`.

Browser/manual frontend and screenshot verification are not applicable: no UI
changed and this repo has no frontend flow for the request. The repo has no
automated browser E2E suite; none was run on either Mac. Tests are Bun unit and
in-process HTTP integration tests, not browser E2Es. Live acceptance is pending
the original failed request evidence, and no deployment verification is claimed.

## Deployment steps for Daniel's approval

**Do not deploy this draft. It contains no runtime repair.** Installing its
binary would not affect the Fatebound-owned endpoint identified above and could
replace a newer manager implementation with the older starting revision.

There are no VM mutation commands to approve for this draft. A truthful exact
deployment command cannot be derived from this checkout: the current VM release
and the service handling the reported HTTP URL are unverified, and the brief
explicitly prohibits accessing the VM. The checked-in unit is a manager-only
service (`ops/systemd/resource-provider.service:12`: `rpcli start manager`),
not evidence of a cosigning HTTP deployment.

The next operator steps, in order, are:

1. Capture the failed request URL, HTTP status/body, UTC timestamp and transaction
   ID from the original playthrough evidence. Share no keys, cookies or env
   dumps. Confirm whether the landed transaction contains the sponsor noop and
   sponsor authorization; a successful transaction can be self-funded fallback.
2. If the URL is Fatebound's same-origin `/api/v1/resource_provider/request_transaction`,
   give the failure to Fatebound Coder. The brief reserves that repo for its
   owner; this Resource Provider VM needs no deployment for that endpoint.
3. If evidence instead identifies the standalone RP service, first identify the
   exact deployed commit/artifact and its real unit/HTTP proxy configuration.
   Reproduce against that source, produce a genuine red-green fix, and run its
   full verification. Do not substitute the branch/PR premise in this brief.
4. Only after the actual fix and artifact exist, prepare the VM's exact upgrade,
   persistence, health-check and rollback commands for Daniel's specific
   production approval. Do not restart a service or deploy this test-only draft
   as a purported fix.

No VM login, restart, deployment, merge, chain write, owner key access, manager
table read, resource-provider database dump or push to `greymass/*` was performed.
The original brief remains untracked and unmodified. No generated evidence is
committed.
