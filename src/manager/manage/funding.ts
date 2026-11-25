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
	const alert = `payer-funding:${account}`;
	const details = { account, funder: policy.funder, amount: String(policy.amount) };
	const balance = payer.core_liquid_balance;
	if (balance && !balance.symbol.equals(policy.amount.symbol)) {
		throw new Error('Payer balance has an unexpected token symbol');
	}
	if (units(balance) >= units(policy.threshold)) {
		await deps.alerts.resolve(alert, `payer ${account}: funding balance recovered`, details);
		return;
	}
	if (account === policy.funder) {
		throw new Error('The funding account must be separate from the payer');
	}

	const reservation = deps.ledger.reserve(
		policy.funder,
		account,
		units(policy.amount),
		units(policy.dailyLimit),
		(deps.now ?? Date.now)()
	);
	if (reservation.status === 'cooldown') return;
	if (reservation.status === 'limit') {
		await deps.alerts.raise(
			alert,
			`payer ${account}: top-up reached its rolling 24-hour cap`,
			details
		);
		return;
	}

	try {
		const sourceBalance = await deps.getBalance(policy.funder);
		if (
			!sourceBalance?.symbol.equals(policy.amount.symbol) ||
			units(sourceBalance) < units(policy.amount)
		) {
			deps.ledger.markUnsent(reservation.id);
			await deps.alerts.raise(
				alert,
				`payer ${account}: funding account cannot cover a top-up`,
				details
			);
			return;
		}
	} catch {
		deps.ledger.markUnsent(reservation.id);
		await deps.alerts.raise(
			alert,
			`payer ${account}: funding account balance check failed`,
			details
		);
		return;
	}

	let transactionId: string;
	try {
		transactionId = await deps.transfer(account, policy.amount, (id) =>
			deps.ledger.recordTransaction(reservation.id, id)
		);
	} catch {
		// A failed response can still have reached the chain. Retain the reserved budget.
		await deps.alerts.raise(alert, `payer ${account}: top-up could not be confirmed`, details);
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
		await deps.alerts.raise(
			alert,
			`payer ${account}: top-up executed but balance readback failed`,
			{ ...details, transactionId }
		);
		return;
	}
	await deps.alerts.resolve(alert, `payer ${account}: top-up executed`, {
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
	if (
		ANTELOPE_CHAIN_ID !== JUNGLE4_CHAIN_ID ||
		ANTELOPE_TOKEN_CONTRACT !== 'eosio.token' ||
		ANTELOPE_SYSTEM_TOKEN !== '4,EOS' ||
		!ANTELOPE_NODEOS_API
	) {
		throw new Error('Automatic payer top-up requires Jungle 4 and eosio.token EOS');
	}

	const env = process.env;
	const funder = env.MANAGER_PAYER_TOPUP_ACCOUNT;
	const permission = env.MANAGER_PAYER_TOPUP_PERMISSION;
	const key = env.MANAGER_PAYER_TOPUP_PRIVATEKEY;
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
	const policy = {
		funder,
		threshold: parseAmount(env.MANAGER_PAYER_TOPUP_TRIGGER),
		amount: parseAmount(env.MANAGER_PAYER_TOPUP_AMOUNT),
		dailyLimit: parseAmount(env.MANAGER_PAYER_TOPUP_DAILY_CAP)
	};
	if (units(policy.amount) > units(policy.dailyLimit)) {
		throw new Error('Top-up transfer amount exceeds the daily cap');
	}

	const boundedFetch = (url: string, options?: RequestInit) =>
		fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
	const client = new APIClient({ url: ANTELOPE_NODEOS_API, fetch: boundedFetch });
	await checkPayerFunding(payer, policy, {
		alerts,
		ledger: payerFundingLedger,
		getBalance: async (account) =>
			(await client.v1.chain.get_currency_balance('eosio.token', account, 'EOS'))[0],
		transfer: async (recipient, quantity, onPrepared) => {
			const info = await client.v1.chain.get_info();
			if (String(info.chain_id) !== JUNGLE4_CHAIN_ID) {
				throw new Error('Funding RPC did not return the Jungle 4 chain ID');
			}
			const session = new Session(
				{
					chain: { id: JUNGLE4_CHAIN_ID, url: ANTELOPE_NODEOS_API },
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
							data: {
								from: funder,
								to: recipient,
								quantity: String(quantity),
								memo: 'Resource Provider payer top-up'
							}
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
		}
	});
}
