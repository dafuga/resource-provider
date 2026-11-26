import { Asset } from '@wharfkit/antelope';
import { beforeEach, expect, it } from 'bun:test';

import { accountData, recordingAlerts } from './helpers';

import { database } from '$lib/db';
import { PayerFundingLedger } from '$lib/db/models/manager/payer-funding';
import { payerFunding } from '$lib/db/schema';
import { checkPayerFunding, fundManagerPayer } from 'src/manager/manage/funding';

const payer = 'rsfui4ahy.gm';
const funder = 'funderacct';
const dry = accountData(payer, { max: 0, used: 0 }, '0.0010 EOS');
const policy = {
	funder,
	threshold: Asset.from('10.0000 EOS'),
	amount: Asset.from('20.0000 EOS'),
	dailyLimit: Asset.from('40.0000 EOS')
};
const day = 24 * 60 * 60 * 1000;
const cooldown = 15 * 60 * 1000;
const receipt = 'a'.repeat(64);

beforeEach(() => database.delete(payerFunding).run());

function fixture() {
	let now = Date.parse('2026-11-25T10:00:00Z');
	const { alerts, sent } = recordingAlerts(() => now);
	const transfers: string[] = [];
	const balanceReads: string[] = [];
	const deps = {
		alerts,
		ledger: new PayerFundingLedger(),
		now: () => now,
		getBalance: async (account: string): Promise<Asset | undefined> => {
			balanceReads.push(account);
			return Asset.from(account === funder ? '100.0000 EOS' : '20.0010 EOS');
		},
		transfer: async (recipient: string, amount: Asset, onPrepared: (id: string) => void) => {
			onPrepared(receipt);
			transfers.push(`${recipient} ${amount}`);
			return receipt;
		}
	};
	return {
		deps,
		transfers,
		balanceReads,
		sent,
		advance: (ms: number) => {
			now += ms;
		}
	};
}

it('leaves automatic funding off without explicit opt-in', async () => {
	const { deps } = fixture();
	await fundManagerPayer(dry, deps.alerts);
	expect(database.select().from(payerFunding).all()).toEqual([]);
});

it('tops up a depleted payer once across overlapping checks and records the receipt and balance readback', async () => {
	const { deps, transfers, balanceReads } = fixture();
	await Promise.all([checkPayerFunding(dry, policy, deps), checkPayerFunding(dry, policy, deps)]);
	expect(transfers).toEqual(['rsfui4ahy.gm 20.0000 EOS']);
	expect(balanceReads).toEqual([funder, payer]);
	expect(database.select().from(payerFunding).all()).toMatchObject([
		{ recipient: payer, funder, units: 200_000, transaction_id: receipt }
	]);

	const healthy = accountData(payer, { max: 10_000_000, used: 0 }, '20.0010 EOS');
	await checkPayerFunding(healthy, policy, deps);
	expect(transfers).toHaveLength(1);
});

it('retains ambiguous attempts across restarts and enforces the rolling 24-hour cap', async () => {
	const { deps, transfers, sent, advance } = fixture();
	const ambiguous = {
		...deps,
		transfer: async (_recipient: string, _amount: Asset, onPrepared: (id: string) => void) => {
			onPrepared('b'.repeat(64));
			throw new Error('response timed out after submitting');
		}
	};
	await checkPayerFunding(dry, policy, ambiguous);
	expect(sent[0].alert.message).toContain('top-up could not be confirmed');
	expect(database.select().from(payerFunding).all()).toMatchObject([
		{ transaction_id: 'b'.repeat(64), units: 200_000 }
	]);

	const restarted = { ...deps, ledger: new PayerFundingLedger() };
	await checkPayerFunding(dry, policy, restarted);
	expect(transfers).toEqual([]);
	advance(cooldown);
	await checkPayerFunding(dry, policy, restarted);
	expect(transfers).toHaveLength(1);
	advance(cooldown);
	await checkPayerFunding(dry, policy, restarted);
	expect(transfers).toHaveLength(1);
	expect(database.select().from(payerFunding).all()).toHaveLength(2);

	advance(day - cooldown * 2 + 1);
	await checkPayerFunding(dry, policy, restarted);
	expect(transfers).toHaveLength(2);
});

it('alerts when the funding account is empty and releases an unsubmitted amount from the cap', async () => {
	const { deps, transfers, sent, advance } = fixture();
	await checkPayerFunding(dry, policy, {
		...deps,
		getBalance: async () => Asset.from('0.0001 EOS')
	});
	expect(sent[0].alert.message).toContain('funding account cannot cover a top-up');
	expect(transfers).toEqual([]);
	expect(database.select().from(payerFunding).all()).toMatchObject([
		{ units: 0, transaction_id: null }
	]);

	advance(cooldown);
	await checkPayerFunding(dry, { ...policy, dailyLimit: policy.amount }, deps);
	expect(transfers).toHaveLength(1);
});
