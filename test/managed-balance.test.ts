import { Asset } from '@wharfkit/antelope';
import { beforeEach, expect, it } from 'bun:test';

import { accountData, recordingAlerts } from './helpers';

import { database } from '$lib/db';
import { PayerFundingLedger } from '$lib/db/models/manager/payer-funding';
import { payerFunding } from '$lib/db/schema';
import {
	checkManagedBalances,
	fundManagedBalances,
	parseBalanceTopups
} from 'src/manager/manage/funding';

const funder = 'rsfui4ahy.gm';
const spec =
	'fbrampay.gm=150.0000 EOS/100.0000 EOS/300.0000 EOS,rammgrtest11=5.0000 EOS/10.0000 EOS/20.0000 EOS';
const cooldown = 15 * 60 * 1000;
const day = 24 * 60 * 60 * 1000;

beforeEach(() => database.delete(payerFunding).run());

function fixture(balances: Record<string, string>) {
	let now = Date.parse('2026-11-26T12:00:00Z');
	const { alerts, sent } = recordingAlerts(() => now);
	const transfers: string[] = [];
	const deps = {
		alerts,
		ledger: new PayerFundingLedger(),
		now: () => now,
		getAccount: async (account: string) =>
			accountData(account, { max: 1_000_000, used: 0 }, balances[account] ?? '0.0000 EOS'),
		getBalance: async (account: string) => Asset.from(balances[account] ?? '0.0000 EOS'),
		transfer: async (recipient: string, amount: Asset, onPrepared: (id: string) => void) => {
			const id = String(transfers.length).padStart(64, '0');
			onPrepared(id);
			transfers.push(`${recipient} ${amount}`);
			balances[recipient] = String(
				Asset.fromUnits(
					Number(Asset.from(balances[recipient]).units) + Number(amount.units),
					'4,EOS'
				)
			);
			return id;
		}
	};
	return { deps, transfers, sent, advance: (ms: number) => (now += ms) };
}

it('parses account=trigger/amount/cap entries and rejects unsafe ones', () => {
	expect(parseBalanceTopups(undefined)).toEqual([]);
	const topups = parseBalanceTopups(spec);
	expect(topups.map((t) => `${t.account} ${t.threshold} ${t.amount} ${t.dailyLimit}`)).toEqual([
		'fbrampay.gm 150.0000 EOS 100.0000 EOS 300.0000 EOS',
		'rammgrtest11 5.0000 EOS 10.0000 EOS 20.0000 EOS'
	]);
	expect(() => parseBalanceTopups('fbrampay.gm=1 EOS/1 EOS/1 EOS')).toThrow();
	expect(() => parseBalanceTopups('fbrampay.gm=1.0000 EOS/5.0000 EOS/2.0000 EOS')).toThrow(
		'daily cap'
	);
	expect(() =>
		parseBalanceTopups(
			'a.gm=1.0000 EOS/1.0000 EOS/1.0000 EOS,a.gm=1.0000 EOS/1.0000 EOS/1.0000 EOS'
		)
	).toThrow('Duplicate');
});

it('refills every drained account from the provider payer, each with its own cooldown and cap', async () => {
	const balances = {
		'fbrampay.gm': '12.0000 EOS',
		rammgrtest11: '0.5000 EOS',
		[funder]: '589.0000 EOS'
	};
	const { deps, transfers, advance } = fixture(balances);
	const topups = parseBalanceTopups(spec);

	await checkManagedBalances(topups, funder, true, deps);
	// One funder, two recipients: the second is not blocked by the first one's cooldown.
	expect(transfers).toEqual(['fbrampay.gm 100.0000 EOS', 'rammgrtest11 10.0000 EOS']);
	expect(database.select().from(payerFunding).all()).toMatchObject([
		{ funder, recipient: 'fbrampay.gm', units: 1_000_000 },
		{ funder, recipient: 'rammgrtest11', units: 100_000 }
	]);

	// fbrampay.gm is still below 150 EOS: it gets another 100 after the cooldown, then hits
	// its 300 EOS rolling cap; rammgrtest11 is healthy and is left alone.
	advance(cooldown);
	await checkManagedBalances(topups, funder, true, deps);
	advance(cooldown);
	balances['fbrampay.gm'] = '1.0000 EOS';
	await checkManagedBalances(topups, funder, true, deps);
	advance(cooldown);
	balances['fbrampay.gm'] = '1.0000 EOS';
	await checkManagedBalances(topups, funder, true, deps);
	expect(transfers).toEqual([
		'fbrampay.gm 100.0000 EOS',
		'rammgrtest11 10.0000 EOS',
		'fbrampay.gm 100.0000 EOS',
		'fbrampay.gm 100.0000 EOS'
	]);
	advance(day);
	await checkManagedBalances(topups, funder, true, deps);
	expect(transfers).toHaveLength(5);
});

it('alerts days ahead when an account drops below its floor and top-up is off', async () => {
	const balances = { 'fbrampay.gm': '149.0000 EOS', rammgrtest11: '9.0289 EOS' };
	const { deps, transfers, sent } = fixture(balances);
	await checkManagedBalances(parseBalanceTopups(spec), undefined, false, deps);
	expect(transfers).toEqual([]);
	expect(sent.map((s) => `${s.alert.status} ${s.alert.key}`)).toEqual([
		'firing balance-low:fbrampay.gm'
	]);
	expect(sent[0].alert.message).toContain('below 150.0000 EOS');

	balances['fbrampay.gm'] = '400.0000 EOS';
	await checkManagedBalances(parseBalanceTopups(spec), undefined, false, deps);
	expect(sent.map((s) => `${s.alert.status} ${s.alert.key}`)).toEqual([
		'firing balance-low:fbrampay.gm',
		'resolved balance-low:fbrampay.gm'
	]);
});

it('alerts instead of sending when the provider payer cannot cover a refill', async () => {
	const balances = {
		'fbrampay.gm': '1.0000 EOS',
		rammgrtest11: '9.0000 EOS',
		[funder]: '50.0000 EOS'
	};
	const { deps, transfers, sent } = fixture(balances);
	await checkManagedBalances(parseBalanceTopups(spec), funder, true, deps);
	expect(transfers).toEqual([]);
	expect(sent.map((s) => `${s.alert.key} ${s.alert.message}`)).toEqual([
		'balance-funding:fbrampay.gm fbrampay.gm balance: funding account cannot cover a top-up'
	]);
});

it('stays off without a list, and refuses owner/active signers when enabled', async () => {
	const { alerts } = recordingAlerts();
	delete process.env.MANAGED_BALANCE_TOPUPS;
	await fundManagedBalances(alerts);
	expect(database.select().from(payerFunding).all()).toEqual([]);

	process.env.MANAGED_BALANCE_TOPUPS = spec;
	process.env.ENABLE_MANAGED_BALANCE_TOPUP = 'true';
	process.env.MANAGED_BALANCE_TOPUP_ACCOUNT = funder;
	process.env.MANAGED_BALANCE_TOPUP_PERMISSION = 'active';
	process.env.MANAGED_BALANCE_TOPUP_PRIVATEKEY = 'not-a-real-key';
	try {
		await expect(fundManagedBalances(alerts)).rejects.toThrow(
			/Jungle 4|scoped transfer permission/
		);
	} finally {
		delete process.env.MANAGED_BALANCE_TOPUPS;
		delete process.env.ENABLE_MANAGED_BALANCE_TOPUP;
		delete process.env.MANAGED_BALANCE_TOPUP_ACCOUNT;
		delete process.env.MANAGED_BALANCE_TOPUP_PERMISSION;
		delete process.env.MANAGED_BALANCE_TOPUP_PRIVATEKEY;
	}
	expect(database.select().from(payerFunding).all()).toEqual([]);
});
