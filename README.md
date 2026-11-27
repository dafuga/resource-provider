# Antelope Resource Provider

The Antelope Resource Provider application provides the following features:

- **Resource Manager**: Automatically manage network resources (CPU + NET, optionally RAM) for a configured list of accounts using PowerUp.
- **Resource Provider**: HTTP API that cosigns transactions to cover network resources on behalf of requesting accounts. Supports a free tier (per-account daily CPU/NET limits) and a paid tier (fee transfer appended to the transaction).
- **Light Account Cosigning**: HTTP API that cosigns `authkey` transactions for light accounts, billing the PowerUp cost plus a configurable margin.
- **Self-Management**: The service account automatically PowerUps itself (and optionally buys RAM) on a schedule so it stays operational.
- (INCOMPLETE) **Request a Powerup**: Direct per-account PowerUp endpoint. Implementation exists in-tree but is currently disabled.

## NOTE: THIS APPLICATION IN DEVELOPMENT

This application is in development and is not yet ready for production use. If you accept this risk, you are free try and use it.

Please report any bugs you may encounter.

## Getting Started

To get started, you will need the following:

1. A Linux server you can download and run the application on.
2. An account on the network that the service will use to interact with the blockchain.
3. A balance of the system token for that network the account can use to obtain resources.

## Download or Build

Precompiled binaries can be downloaded directly from the [Releases](https://github.com/greymass/resource-provider/releases) page. Download the binary, decompress the gzip file, and place it into a directory of your choice.

Alternatively, you can clone down this repository and run `make build` to create the binary yourself. The resulting files can be found in the `./dist` directory inside the project.

## Configuration

This application requires an `.env` file in the same folder to control many of its settings.

Running `rpcli config` will generate a basic `.env` file in the folder you run it from. This file will need to be edited to configure the blockchain, accounts, and services involved.

Alternatively, the `.env.example` file can be copied directly to the `.env` and edited.

## Setup as Resource Mananger

### Modify Configuration

To start managing the resources of Antelope accounts, the `.env` file requires two things:

```
# Enable the resource manager by setting this value to true
ENABLE_RESOURCE_MANAGER=true

# Enter the account name of the dedicated resource management account
MANAGER_ACCOUNT_NAME=accountname
```

A number of other optional configuration values may be set and can be found inside the `.env`.

If no private key is defined within the `.env` file, one will be generated automatically for use within the service.

### Account Permission Setup

With the above settings defined in the `.env` file, run the following command:

```
rpcli manager setup
```

This command will generate a link that will assist in setting up the proper permissions for the account. Visit the Unicove link in your browser, ensure you are logged in with the dedicated manager account, review the transaction and sign it.

This new permission will be restricted to managing resources and use the key embedded within the service.

To remove this permission in the future, you can do so manually or run:

```
rpcli manager unauthorize
```

### Add accounts to manage

The `rpcli` allows you to define which accounts will be automatically managed.

To add an account, use the `rpcli manager add` command:

```
rpcli manager add <account> <min_ms> <min_kb> <inc_ms> <inc_kb> <max_fee> [min_ram_kb] [inc_ram_kb] [ram_daily_max_fee]
```

The values required for this command are as follows:

- `account` is the account name to manage resources for
- `min_ms` the minimum amount of CPU (in milliseconds) the account should have available
- `min_kb` the minimum amount of NET (in kilobytes) the account should have available
- `inc_ms` the amount of CPU (in milliseconds) to powerup when the minimum is not met
- `inc_kb` the amount of NET (in kilobytes) to powerup when the minimum is not met
- `max_fee` the maximum fee to pay for the powerup action
- `min_ram_kb` / `inc_ram_kb` (optional, needs `ENABLE_MANAGED_ACCOUNT_RAM=true`) buy `inc_ram_kb` of RAM when free RAM falls below `min_ram_kb`
- `ram_daily_max_fee` (optional) cap on the estimated RAM spend for this account per rolling 24 hours, in system tokens. `0` uses `MANAGED_ACCOUNT_RAM_DAILY_MAX_FEE` (no cap by default). Purchases are recorded in the database, so the cap survives restarts. A skipped top-up raises a `ram-cap` alert.
- `MANAGED_ACCOUNT_RAM_MAX_FEE` (default 5) caps each single RAM purchase. When the deficit would cost more, the manager buys what fits and buys the rest in later cycles (one per `MANAGER_POWERUP_COOLDOWN_SECONDS`); the daily cap still applies to the total. If nothing fits, it raises a `ram-max-fee` alert

So for example, to ensure the `ihasnocpunet` account always has 10ms and 10kb resources available, and setting the maximum fee to `0.5000 TOKEN`, the command would be:

```
rpcli manager add ihasnocpunet 10 10 10 10 0.5
```

To modify the values set for an account, just run `rpcli manager add` again for the account and it will overwrite its configuration.

### Listing managed accounts

To display the accounts currently under management and their configurations, run the following command.

```
rpcli manager list
```

A list of accounts will be displayed on the command line as follows:

```
┌───┬──────────────┬────────┬────────┬────────┬────────┬──────────┐
│   │ account      │ min_ms │ min_kb │ inc_ms │ inc_kb │ max_fee  │
├───┼──────────────┼────────┼────────┼────────┼────────┼──────────┤
│ 0 │ ihasnocpunet │ 10     │ 10     │ 10     │ 10     │ 0.5000 A │
└───┴──────────────┴────────┴────────┴────────┴────────┴──────────┘
```

### Removing an account from management

To completely remove an account from management, use the `manager remove` command followed by the account name:

```
rpcli manager remove ihasnocpunet
```

## Setup as Resource Provider

The Resource Provider runs an HTTP API that cosigns transactions to cover CPU and NET for requesting accounts. It uses a dedicated account (distinct from the manager account) whose permission is restricted to the noop action (and the light account `authkey` action, if enabled).

### Modify Configuration

At minimum:

```
# Enable the provider API
ENABLE_RESOURCE_PROVIDER=true

# The cosigning account
PROVIDER_ACCOUNT_NAME=accountname

# Enable one or more cosigning modes:
ENABLE_FREE_TRANSACTIONS=true
ENABLE_PAID_TRANSACTIONS=true
```

If no `PROVIDER_ACCOUNT_PRIVATEKEY` is set, one will be generated on first run.

Free cosigning requires `PROVIDER_FREE_TRANSACTIONS_LIMIT_MS` and `PROVIDER_FREE_TRANSACTIONS_LIMIT_KB` (the per-account, per-window CPU/NET limits). Paid cosigning is on by default and appends a fee transfer to the transaction; see `.env.example` for fee, recipient, and memo configuration.

See `.env.example` for the full list of provider options, including resource-sufficiency gating (`PROVIDER_REQUIRE_RESOURCE_NEED`), the usage window (`PROVIDER_USAGE_WINDOW_HOURS`), and the light account cosigning feature (`ENABLE_LIGHTACCOUNT_PROVIDER`).

### Account Permission Setup

With the provider configuration in place, run:

```
rpcli provider setup
```

This generates a signing request that creates the dedicated provider permission on the account, binds the provider's key to it, and links the permission to the noop action (and the light account `authkey` action, if `ENABLE_LIGHTACCOUNT_PROVIDER=true`). Open the printed link in your browser, sign with the account's active permission, then re-run the command to verify the account is configured.

## Self-Management

When `ENABLE_SELF_MANAGEMENT=true` (the default), the service runs a cron job that keeps the configured `MANAGER_ACCOUNT_NAME` operational by automatically PowerUp-ing CPU and NET when it drops below `MANAGER_MIN_MS` / `MANAGER_MIN_KB`, and (if `MANAGER_BUYRAM_ENABLED=true`) buying a small amount of RAM when the account falls below `MANAGER_RAM_MINIMUM_KB`. Each cycle caps payment at `MANAGER_MAX_FEE`. The schedule is controlled by `MANAGER_SELF_CRONJOB`.

This feature requires the same account setup as the Resource Manager (`rpcli manager setup`).

The manager account is also the payer for every managed account, so self-management is built to never go quiet:

- The startup account check is retried with exponential backoff (capped at `MANAGER_SELF_RETRY_MAX_SECONDS`) until it succeeds; a transient DNS or RPC error no longer stops self-management for the life of the process.
- Each check is single-flight (the startup run, the cron and a payer rescue share one run) and is abandoned after `MANAGER_SELF_CHECK_TIMEOUT_SECONDS`, so a hung call cannot block the cron.
- The account's own leases are renewed `MANAGER_SELF_RENEW_BEFORE_EXPIRY_MINUTES` (default 360) before they expire.
- Each resource-manager cycle checks the payer first. Below `MANAGER_PAYER_RESERVE_MS` of CPU it cannot pay for other accounts, so it runs the payer's own check first (a self-powerup still lands at 0 CPU) and skips managed accounts until the payer recovers.

## Alerts

Alerts are logged at error level (`ALERT: ...`) and, when `ALERT_WEBHOOK_URL` is set, POSTed as JSON (`{ text, content, alert }`, readable by Slack and Discord). A firing alert repeats at most every `ALERT_REPEAT_MINUTES`, and a `RESOLVED` notice is sent when it clears.

| Alert                      | Fires when                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `lease-expiring:<account>` | the lease carrying most of the account's (or payer's) CPU/NET expires within `ALERT_LEASE_EXPIRY_MINUTES` and was not renewed |
| `cpu-low:<account>`        | the account (or payer) stays below its CPU minimum for `ALERT_CPU_GRACE_SECONDS`                                              |
| `payer-dry:<payer>`        | the payer has less than `MANAGER_PAYER_RESERVE_MS` of CPU and cannot pay for managed accounts                                 |
| `payer-balance:<payer>`    | the payer's liquid balance is below `ALERT_PAYER_MIN_BALANCE`                                                                 |
| `self-stale`               | self-management has not completed a check for `ALERT_SELF_STALE_MINUTES`                                                      |
| `self-verify`              | the startup account check keeps failing, or the permission/key is misconfigured                                               |
| `ram-cap:<account>`        | a RAM top-up was skipped because of the account's daily RAM cap                                                               |
| `ram-max-fee:<account>`    | RAM is needed but no part of the top-up can be bought within `MANAGED_ACCOUNT_RAM_MAX_FEE`                                    |
| `payer-funding:<payer>`    | automatic funding is capped, cannot fund, or its transfer/readback fails                                                      |

### Optional Jungle 4 payer funding

Set `ALERT_WEBHOOK_URL` to a monitored webhook for delivery outside the service log. Set the alert threshold above the funding trigger so operators get an early warning. Size the reserve from recent fees and upcoming lease renewals.

Automatic funding is disabled by default. With an approved, dedicated Jungle 4 funding account, link a separate permission to `eosio.token::transfer` and provision its key through the service's secret store. Set the account, permission and key using `MANAGER_PAYER_TOPUP_ACCOUNT`, `MANAGER_PAYER_TOPUP_PERMISSION` and `MANAGER_PAYER_TOPUP_PRIVATEKEY`. Set `MANAGER_PAYER_TOPUP_TRIGGER`, `MANAGER_PAYER_TOPUP_AMOUNT` and `MANAGER_PAYER_TOPUP_DAILY_CAP` as explicit assets such as `1.0000 EOS`. Set `ENABLE_MANAGER_PAYER_TOPUP=true` only after the source and limits are approved.

The manager checks the configured payer's liquid balance before its CPU rescue. Below the trigger it can transfer the fixed amount from the funding account. Use one shared manager database. It reserves each attempt before sending, limits attempts to one every 15 minutes, and keeps unconfirmed transfers charged against the rolling 24-hour cap. An executed receipt and the payer's post-transfer balance are recorded in the service log.

### Keeping every app and game account covered (Jungle 4)

`deploy/jungle4-managed-accounts.json` lists every account the RNG games and services rely on: the sponsor and RAM payers, the RAM gift account, oracle signers, keepers, contracts and QA actors. Enrol each row with `rpcli manager add` (run it from the service's working directory so the env file loads), and check the live chain with `bun scripts/coverage-readback.ts`, which exits non-zero when any account is below its floor.

Some accounts spend their own liquid EOS for players, such as RAM purchases by the sponsor payer. List them in `MANAGED_BALANCE_TOPUPS` as `account=trigger/amount/daily-cap`, for example `fbrampay.gm=150.0000 EOS/100.0000 EOS/300.0000 EOS`. Below the trigger the manager raises a `balance-low:<account>` alert. With `ENABLE_MANAGED_BALANCE_TOPUP=true` it transfers the amount from `MANAGED_BALANCE_TOPUP_ACCOUNT` (normally the payer) using `MANAGED_BALANCE_TOPUP_PERMISSION`. This must be a dedicated permission linked only to `eosio.token::transfer`, never owner or active. Its key goes in `MANAGED_BALANCE_TOPUP_PRIVATEKEY`. Each recipient has its own 15-minute cooldown and rolling 24-hour cap, recorded in the same ledger as payer funding.

When `ALERT_MANAGE_FAILURES` (default 6) top-up attempts in a row fail for one managed account, the manager raises `manage-failed:<account>`.

## Running the Services

Start everything:

```
rpcli start
```

Or start a single service:

```
rpcli start api
rpcli start manager
```

## Usage and Database Commands

```
rpcli usage <account>   # Show cosigning usage for an account (within PROVIDER_USAGE_WINDOW_HOURS)
rpcli reset             # Clear all usage-tracking records
rpcli vacuum            # Force SQLite VACUUM on the database
```

### Tests

`make test`

## Optional Transaction Pass RAM sponsor

The RAM_MANAGER_URL and RAM_MANAGER_TOKEN server settings enable the standalone
[RAM Manager](https://github.com/dafuga/ram-manager) on Jungle4. The provider first
simulates each transaction, validates its RAM payer, then requests the required account
quota with a 50-byte safety buffer. Configure a provisioning-only API key for the
Transaction Pass client in RAM Manager. The manager authenticates the key, checks
that client's unexpired member list, and enforces member, client and global caps.
Transaction Pass manages the member list using its own full client key; the provider
key cannot add members or change allowances. Never use the service's admin token.

Eligible transactions are re-estimated after capacity is ensured. The original
transaction never gains a player-funded RAM purchase. A pending gift, foreign giver,
budget ceiling, or oversized transaction stops sponsorship without silently charging
the player. Ineligible accounts retain the existing provider behavior. No browser
credential or new wallet plugin is required. CPU/NET quotas remain unchanged.

Keep these settings unset until the sponsor is funded and the separate service is
running. The first service release is pinned to Jungle4; the provider rejects this
integration on another chain. Use the same giver as existing account-creation gifts.
