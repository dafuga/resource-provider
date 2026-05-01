# Antelope Resource Provider

The Antelope Resource Provider application provides the following features:

- **Resource Manager**: Automatically manage CPU, NET, and RAM resources of selected accounts.
- (INCOMPLETE) **Resource Provider**: Provide an HTTP API that allows users to request the coverage of network resources by cosigning transactions.
- (INCOMPLETE) **Request a Powerup**: Provide an HTTP API that allows users to request a powerup to their account by supplying the account name.

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
rpcli manager add <account> <min_ms> <min_kb> <inc_ms> <inc_kb> <max_fee> [min_ram_kb] [inc_ram_kb]
```

The values required for this command are as follows:

- `account` is the account name to manage resources for
- `min_ms` the minimum amount of CPU (in milliseconds) the account should have available
- `min_kb` the minimum amount of NET (in kilobytes) the account should have available
- `inc_ms` the amount of CPU (in milliseconds) to powerup when the minimum is not met
- `inc_kb` the amount of NET (in kilobytes) to powerup when the minimum is not met
- `max_fee` the maximum fee to pay for the powerup action
- `min_ram_kb` the optional minimum amount of free RAM (in kilobytes) the account should have available
- `inc_ram_kb` the optional amount of RAM (in kilobytes) to buy when the RAM minimum is not met

So for example, to ensure the `ihasnocpunet` account always has 10ms and 10kb network resources available, and setting the maximum fee to `0.5000 TOKEN`, the command would be:

```
rpcli manager add ihasnocpunet 10 10 10 10 0.5
```

To also keep 20kb of RAM free and buy another 10kb when that threshold is not met:

```
rpcli manager add ihasnocpunet 10 10 10 10 0.5 20 10
```

Managed account RAM purchases are opt-in and only available on Jungle 4 for now. Set `ENABLE_MANAGED_ACCOUNT_RAM=true` in addition to configuring non-zero `min_ram_kb` and `inc_ram_kb` values for the accounts that should receive RAM.

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

### Tests

`make test`
