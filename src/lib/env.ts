import { generalLog } from './logger';

const defaultEnvContent = `#######################################################
### BLOCKCHAIN CONFIGURATION
#######################################################

# REQUIRED - Blockchain ID
ANTELOPE_CHAIN_ID=aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906

# REQUIRED - API Endpoint (nodeos)
ANTELOPE_NODEOS_API=https://eos.greymass.com

# REQUIRED - System Token Symbol (e.g. "4,TOKEN")
ANTELOPE_SYSTEM_TOKEN=4,A

# System Contract to use during powerup, buyram, etc
# ANTELOPE_SYSTEM_CONTRACT=eosio

# System Token Contract
# ANTELOPE_TOKEN_CONTRACT=eosio

# Noop Contract to use for cosigning
# ANTELOPE_NOOP_CONTRACT=greymassnoop

# Sample account to use for resource calculations
# ANTELOPE_SAMPLE_ACCOUNT=eosio.reserv

#######################################################
### AUTOMATED RESOURCE MANAGEMENT
#######################################################

# Enable the automated resource management system? (default: false)
ENABLE_RESOURCE_MANAGER=false

# REQUIRED - Account name that will hold a token balance and powerup other accounts
MANAGER_ACCOUNT_NAME=

# Private key to the account/permission
# MANAGER_ACCOUNT_PRIVATEKEY=

# Permission on the account to use (default: "manager")
# MANAGER_ACCOUNT_PERMISSION=manager

# Allow the manager to automatically purchase RAM for itself for powerups (default: true)
# MANAGER_BUYRAM_ENABLED=true

# The minimum amount of available RAM (in KB) the manager should have to operate (default: 1)
# MANAGER_RAM_MINIMUM_KB=1

# The amount of RAM (in KB) the manager should purchase if it falls below the minimum (default: 1)
# MANAGER_BUYRAM_INCREMENT_KB=1

# The action used on the system contract to buy RAM (default: buyrambytes)
# MANAGER_BUYRAM_ACTION=buyrambytes

# The interval at which the manager will evaluate and act upon resource needs (cron style)
# MANAGER_CRONJOB='0/10 * * * * *'

# The minimum available CPU (in milliseconds) the management account should maintain
# MANAGER_MIN_MS=5

# The minimum available NET (in kilobytes) the management account should maintain
# MANAGER_MIN_KB=5

# Allow managed accounts to receive automatic RAM purchases.
# This is opt-in and only supported on Jungle 4 for now.
# ENABLE_MANAGED_ACCOUNT_RAM=false

# The amount of free RAM (in KB) to keep on managed accounts by default.
# MANAGED_ACCOUNT_RAM_MINIMUM_KB=100

# The amount of RAM (in KB) to buy when a managed account falls below its RAM minimum.
# Defaults to MANAGED_ACCOUNT_RAM_MINIMUM_KB when unset.
# MANAGED_ACCOUNT_RAM_INCREMENT_KB=100

# The amount of CPU (in milliseconds) the management account should powerup for itself when needed
# MANAGER_INC_MS=10

# The amount of NET (in kilobytes) the management account should powerup for itself when needed
# MANAGER_INC_KB=10

# The maximum fee the manager should spend when powering up itself
# MANAGER_MAX_FEE=0.25

#######################################################
### PROVIDER CONFIGURATION
#######################################################

### ---------------------------------------------------
### PROVIDER ACCOUNT

# REQUIRED - Account name of the cosigning account
# PROVIDER_ACCOUNT_NAME=

# REQUIRED - Permission on the account to use
# PROVIDER_ACCOUNT_PERMISSION=

# REQUIRED - Private key to the account/permission
# PROVIDER_ACCOUNT_PRIVATEKEY=

### ---------------------------------------------------
### FREE POWERUPS

# REQUIRED - Whether to allow direct free powerups
# PROVIDER_FREE_POWERUP=true

# REQUIRED - CPU Amount (ms) to provide in a free powerup
# PROVIDER_FREE_POWERUP_MS=1

# REQUIRED - NET Amount (kb) to provide in a free powerup
# PROVIDER_FREE_POWERUP_KB=1

# REQUIRED - Number of uses per account, per day
# PROVIDER_FREE_POWERUP_USES=1

# REQUIRED - Maximum payment per free powerup
# PROVIDER_FREE_POWERUP_MAX_PAYMENT=1.0000

### ---------------------------------------------------
### FREE COSIGNING

# Whether to allow free transaction cosigning
# PROVIDER_FREE_TRANSACTIONS=true

# CPU Amount (ms) to allow per day via cosigning
# PROVIDER_FREE_TRANSACTIONS_LIMIT_MS=10

# NET Amount (kb) to allow per day via cosigning
# PROVIDER_FREE_TRANSACTIONS_LIMIT_KB=10

### ---------------------------------------------------
### TRANSACTION FEE COSIGNING

# Whether to provide fee-based transaction cosigning
# PROVIDER_PAID_TRANSACTIONS=true

# Asset used as the fee
# PROVIDER_PAID_TRANSACTIONS_ASSET=4,A

# Minimum fee for all transactions
# PROVIDER_PAID_MINIMUM_FEE=0.0001

#######################################################
### GENERAL CONFIGURATION
#######################################################

# ENVIRONMENT=development
# SERVICE_HTTP_PORT=3000
# SERVICE_LOG_LEVEL=debug
# SERVICE_INFO_LOG=./info.log
# SERVICE_ERROR_LOG=./error.log

# DATABASE_ADAPTER=sqlite
# DATABASE_FILE="provider.sqlite"

# ENABLE_FREE_POWERUP=true
# ENABLE_RESOURCE_PROVIDER=true
`;

export async function createEnvironmentalFile() {
	const path = './.env';
	const file = Bun.file(path);

	const exists = await file.exists();

	if (exists) {
		generalLog.warn(`Configuration file already exists, skipping.`);
		process.exit();
	}

	await Bun.write(path, defaultEnvContent);
}
