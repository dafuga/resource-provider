import { API, APIClient, Asset, Name, SignedTransaction } from '@wharfkit/antelope';
import { Session } from '@wharfkit/session';
import { WalletPluginPrivateKey } from '@wharfkit/wallet-plugin-privatekey';

import type { Alerts } from '$lib/alerts';
import { type PayerFundingLedger, payerFundingLedger } from '$lib/db/models/manager/payer-funding';
import { managerLog } from '$lib/logger';
import {
	ANTELOPE_CHAIN_ID,
	ANTELOPE_NODEOS_API,
	ANTELOPE_SYSTEM_TOKEN,
	ANTELOPE_TOKEN_CONTRACT,
	JUNGLE4_CHAIN_ID
} from 'src/config';

interface FundingPolicy {
	funder: string;
	threshold: Asset;
	amount: Asset;
	dailyLimit: Asset;
	// Alert key prefix and the name used in messages; default to the payer wording.
	alertPrefix?: string;
	label?: string;
	// Count the cooldown and daily cap per recipient instead of per funder.
	perRecipient?: boolean;
}

interface FundingDeps {
	alerts: Alerts;
	ledger: Pick<PayerFundingLedger, 'reserve' | 'markUnsent' | 'recordTransaction'>;
	getBalance: (account: string) => Promise<Asset | undefined>;
	transfer: (recipient: string, amount: Asset, onPrepared: (id: string) => void) => Promise<string>;
	now?: () => number;
}

function units(value: Asset | undefined) {
	return value ? Number(value.units) : 0;
}

export async function checkPayerFunding(
	payer: API.v1.AccountObject,
	policy: FundingPolicy,
	deps: FundingDeps
) {
	const account = String(payer.account_name);
	const alert = `${policy.alertPrefix ?? 'payer-funding'}:${account}`;
	const who = policy.label ?? `payer ${account}`;
	const details = { account, funder: policy.funder, amount: String(policy.amount) };
	const balance = payer.core_liquid_balance;
	if (balance && !balance.symbol.equals(policy.amount.symbol)) {
		throw new Error(`${who}: balance has an unexpected token symbol`);
	}
	if (units(balance) >= units(policy.threshold)) {
		await deps.alerts.resolve(alert, `${who}: funding balance recovered`, details);
		return;
	}
	if (account === policy.funder) {
		throw new Error(`${who}: the funding account must be separate from the recipient`);
	}

	const reservation = deps.ledger.reserve(
		policy.funder,
		account,
		units(policy.amount),
		units(policy.dailyLimit),
		(deps.now ?? Date.now)(),
		{ perRecipient: policy.perRecipient }
	);
	if (reservation.status === 'cooldown') return;
	if (reservation.status === 'limit') {
		await deps.alerts.raise(alert, `${who}: top-up reached its rolling 24-hour cap`, details);
		return;
	}

	try {
		const sourceBalance = await deps.getBalance(policy.funder);
		if (
			!sourceBalance?.symbol.equals(policy.amount.symbol) ||
			units(sourceBalance) < units(policy.amount)
		) {
			deps.ledger.markUnsent(reservation.id);
			await deps.alerts.raise(alert, `${who}: funding account cannot cover a top-up`, details);
			return;
		}
	} catch {
		deps.ledger.markUnsent(reservation.id);
		await deps.alerts.raise(alert, `${who}: funding account balance check failed`, details);
		return;
	}

	let transactionId: string;
	try {
		transactionId = await deps.transfer(account, policy.amount, (id) =>
			deps.ledger.recordTransaction(reservation.id, id)
		);
	} catch {
		// A failed response can still have reached the chain. Retain the reserved budget.
		await deps.alerts.raise(alert, `${who}: top-up could not be confirmed`, details);
		return;
	}

	managerLog.info('Payer top-up executed', { ...details, transactionId });
	try {
		const readback = await deps.getBalance(account);
		managerLog.info('Payer top-up balance readback', {
			...details,
			transactionId,
			balance: String(readback ?? '0.0000 EOS')
		});
	} catch {
		await deps.alerts.raise(alert, `${who}: top-up executed but balance readback failed`, {
			...details,
			transactionId
		});
		return;
	}
	await deps.alerts.resolve(alert, `${who}: top-up executed`, {
		...details,
		transactionId
	});
}

function parseAmount(value: string | undefined) {
	if (!value || !/^(?:0|[1-9]\d*)\.\d{4} EOS$/.test(value)) {
		throw new Error('Top-up amounts must be explicit EOS assets with four decimal places');
	}
	const amount = Asset.from(value);
	if (!Number.isSafeInteger(units(amount)) || units(amount) <= 0) {
		throw new Error('Top-up amounts must be positive and within the supported range');
	}
	return amount;
}

export async function fundManagerPayer(payer: API.v1.AccountObject, alerts: Alerts) {
	if (process.env.ENABLE_MANAGER_PAYER_TOPUP !== 'true') return;
	requireJungle4Eos('Automatic payer top-up');

	const env = process.env;
	const { funder, permission, key } = scopedSigner(
		env.MANAGER_PAYER_TOPUP_ACCOUNT,
		env.MANAGER_PAYER_TOPUP_PERMISSION,
		env.MANAGER_PAYER_TOPUP_PRIVATEKEY
	);
	const policy = {
		funder,
		threshold: parseAmount(env.MANAGER_PAYER_TOPUP_TRIGGER),
		amount: parseAmount(env.MANAGER_PAYER_TOPUP_AMOUNT),
		dailyLimit: parseAmount(env.MANAGER_PAYER_TOPUP_DAILY_CAP)
	};
	if (units(policy.amount) > units(policy.dailyLimit)) {
		throw new Error('Top-up transfer amount exceeds the daily cap');
	}

	const client = fundingClient();
	await checkPayerFunding(payer, policy, {
		alerts,
		ledger: payerFundingLedger,
		getBalance: (account) => getEosBalance(client, account),
		transfer: makeFundingTransfer(client, funder, permission, key, 'Resource Provider payer top-up')
	});
}

const boundedFetch = (url: string, options?: RequestInit) =>
	fetch(url, { ...options, signal: AbortSignal.timeout(5000) });

function fundingClient() {
	return new APIClient({ url: String(ANTELOPE_NODEOS_API), fetch: boundedFetch });
}

async function getEosBalance(client: APIClient, account: string) {
	return (await client.v1.chain.get_currency_balance('eosio.token', account, 'EOS'))[0];
}

function requireJungle4Eos(what: string) {
	if (
		ANTELOPE_CHAIN_ID !== JUNGLE4_CHAIN_ID ||
		ANTELOPE_TOKEN_CONTRACT !== 'eosio.token' ||
		ANTELOPE_SYSTEM_TOKEN !== '4,EOS' ||
		!ANTELOPE_NODEOS_API
	) {
		throw new Error(`${what} requires Jungle 4 and eosio.token EOS`);
	}
}

// A transfer-only signer: the permission must be a dedicated child permission, never owner
// or active, so a leaked key can only move tokens within the caps enforced here.
function scopedSigner(funder?: string, permission?: string, key?: string) {
	if (
		!funder ||
		String(Name.from(funder)) !== funder ||
		!permission ||
		String(Name.from(permission)) !== permission ||
		permission === 'owner' ||
		permission === 'active' ||
		!key
	) {
		throw new Error('Set a dedicated funding account and scoped transfer permission');
	}
	return { funder, permission, key };
}

function makeFundingTransfer(
	client: APIClient,
	funder: string,
	permission: string,
	key: string,
	memo: string
): FundingDeps['transfer'] {
	return async (recipient, quantity, onPrepared) => {
		const info = await client.v1.chain.get_info();
		if (String(info.chain_id) !== JUNGLE4_CHAIN_ID) {
			throw new Error('Funding RPC did not return the Jungle 4 chain ID');
		}
		const session = new Session(
			{
				chain: { id: JUNGLE4_CHAIN_ID, url: String(ANTELOPE_NODEOS_API) },
				actor: funder,
				permission,
				walletPlugin: new WalletPluginPrivateKey(key)
			},
			{ fetch: boundedFetch }
		);
		const result = await session.transact(
			{
				actions: [
					{
						account: 'eosio.token',
						name: 'transfer',
						authorization: [session.permissionLevel],
						data: { from: funder, to: recipient, quantity: String(quantity), memo }
					}
				]
			},
			{ broadcast: false }
		);
		const resolved = result.resolved?.transaction;
		if (!resolved || !result.signatures.length)
			throw new Error('Funding transaction was not signed');
		const transactionId = String(resolved.id);
		const signed = SignedTransaction.from({ ...resolved, signatures: result.signatures });
		onPrepared(transactionId);
		const response = await client.v1.chain.push_transaction(signed);
		if (
			String(response.transaction_id) !== transactionId ||
			response.processed?.receipt?.status !== 'executed'
		) {
			throw new Error('Funding transaction did not return an executed receipt');
		}
		return transactionId;
	};
}

export interface BalanceTopup {
	account: string;
	threshold: Asset;
	amount: Asset;
	dailyLimit: Asset;
}

// MANAGED_BALANCE_TOPUPS lists accounts that spend their own liquid EOS (sponsor RAM payers,
// RAM gift accounts) and the floor the provider keeps them above:
//   "fbrampay.gm=150.0000 EOS/100.0000 EOS/300.0000 EOS,rammgrtest11=5.0000 EOS/10.0000 EOS/20.0000 EOS"
// Each entry is account=trigger/amount/rolling-24h-cap.
export function parseBalanceTopups(spec: string | undefined): BalanceTopup[] {
	if (!spec?.trim()) return [];
	const seen = new Set<string>();
	return spec.split(',').map((entry) => {
		const [account, values] = entry.trim().split('=');
		const parts = (values ?? '').split('/').map((value) => value.trim());
		if (!account || String(Name.from(account)) !== account || parts.length !== 3) {
			throw new Error(`Invalid MANAGED_BALANCE_TOPUPS entry: ${entry.trim()}`);
		}
		if (seen.has(account)) throw new Error(`Duplicate MANAGED_BALANCE_TOPUPS account: ${account}`);
		seen.add(account);
		const [threshold, amount, dailyLimit] = parts.map(parseAmount);
		if (units(amount) > units(dailyLimit)) {
			throw new Error(`${account}: top-up amount exceeds its daily cap`);
		}
		return { account, threshold, amount, dailyLimit };
	});
}

export interface BalanceFundingDeps extends FundingDeps {
	getAccount: (account: string) => Promise<API.v1.AccountObject>;
}

// Keeps every listed account's liquid EOS above its trigger by transferring from the
// funder. With automatic top-up off it still alerts below the trigger, so a draining
// account is reported days before it runs dry.
export async function checkManagedBalances(
	topups: BalanceTopup[],
	funder: string | undefined,
	enabled: boolean,
	deps: BalanceFundingDeps
) {
	for (const topup of topups) {
		const label = `${topup.account} balance`;
		const lowKey = `balance-low:${topup.account}`;
		try {
			const data = await deps.getAccount(topup.account);
			const balance = data.core_liquid_balance;
			const low = units(balance) < units(topup.threshold);
			const details = {
				account: topup.account,
				balance: String(balance ?? '0.0000 EOS'),
				threshold: String(topup.threshold)
			};
			if (!low) {
				await deps.alerts.resolve(lowKey, `${label} back above ${topup.threshold}`, details);
			} else if (!enabled || !funder) {
				await deps.alerts.raise(
					lowKey,
					`${label} is ${details.balance}, below ${topup.threshold}; automatic top-up is off`,
					details
				);
			}
			if (!enabled || !funder) continue;
			await checkPayerFunding(
				data,
				{ ...topup, funder, alertPrefix: 'balance-funding', label, perRecipient: true },
				deps
			);
		} catch (error) {
			managerLog.error('Managed balance check failed', {
				account: topup.account,
				error: String(error)
			});
			await deps.alerts.raise(
				`balance-funding:${topup.account}`,
				`${label}: balance check failed`,
				{ account: topup.account }
			);
		}
	}
}

export async function fundManagedBalances(alerts: Alerts) {
	const topups = parseBalanceTopups(process.env.MANAGED_BALANCE_TOPUPS);
	if (!topups.length) return;
	requireJungle4Eos('Managed balance top-up');
	const env = process.env;
	const enabled = env.ENABLE_MANAGED_BALANCE_TOPUP === 'true';
	const client = fundingClient();
	let funder: string | undefined;
	let transfer: FundingDeps['transfer'] = async () => {
		throw new Error('Managed balance top-up is disabled');
	};
	if (enabled) {
		const signer = scopedSigner(
			env.MANAGED_BALANCE_TOPUP_ACCOUNT,
			env.MANAGED_BALANCE_TOPUP_PERMISSION,
			env.MANAGED_BALANCE_TOPUP_PRIVATEKEY
		);
		funder = signer.funder;
		transfer = makeFundingTransfer(
			client,
			signer.funder,
			signer.permission,
			signer.key,
			'Resource Provider managed balance top-up'
		);
	}
	await checkManagedBalances(topups, funder, enabled, {
		alerts,
		ledger: payerFundingLedger,
		getAccount: (account) => client.v1.chain.get_account(account),
		getBalance: (account) => getEosBalance(client, account),
		transfer
	});
}
