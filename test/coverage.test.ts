import { API, Asset, Int64 } from '@wharfkit/antelope';
import { Session } from '@wharfkit/session';
import { afterEach, describe, expect, it } from 'bun:test';

import inventory from '../deploy/jungle4-managed-accounts.json';

import { accountData, recordingAlerts } from './helpers';

import { alerts } from '$lib/alerts';
import { ManagedAccount } from '$lib/db/models/manager/account';
import {
	getAccountCurrentResources,
	getAccountRequiresRAM,
	getAccountRequiredResources,
	getPurchaseAmounts,
	getRamPurchaseBytes
} from '$lib/wharf/resources';
import { runManagerCycle } from 'src/manager';
import type { ManagerContext } from 'src/manager/context';
import { manageAccountResources, resetManageFailures } from 'src/manager/manage/account';
import { parseBalanceTopups } from 'src/manager/manage/funding';

function managed(row: (typeof inventory.managed)[number]) {
	return ManagedAccount.from({ ...row, max_fee: Asset.from(row.max_fee) });
}

// A drained account: every us of CPU and byte of NET used, no free RAM.
function drained(name: string): API.v1.AccountObject {
	const data = accountData(name, { max: 1000, used: 1000 }, '0.0000 EOS');
	return {
		...data,
		net_limit: { max: Int64.from(1000), used: Int64.from(1000), current_used: Int64.from(1000) },
		ram_quota: Int64.from(10_000),
		ram_usage: Int64.from(10_000)
	} as unknown as API.v1.AccountObject;
}

describe('every account our apps and games rely on is covered (cxvh89)', () => {
	it('lists the sponsor payer, RAM gifter, oracle signers, keepers, contracts and QA actors', () => {
		const names = inventory.managed.map((row) => row.account);
		for (const required of [
			'fbrampay.gm',
			'rammgrtest11',
			'5ip24l2kc.gm',
			'rngoracle.gm',
			'fatebound.gm',
			'rngfront.gm',
			'pigracing.gm',
			'chainmate.gm',
			'yvcpg2lnc.gm'
		]) {
			expect(names).toContain(required);
		}
		expect(new Set(names).size).toBe(names.length);
		expect(names).not.toContain('rsfui4ahy.gm');
	});

	for (const row of inventory.managed) {
		it(`dry run: a drained ${row.account} gets CPU and NET back above its floor`, () => {
			const account = managed(row);
			const data = drained(row.account);
			const required = getAccountRequiredResources(account, data);
			expect(required.cpuRequired).toBeTrue();
			expect(required.netRequired).toBeTrue();
			const amounts = getPurchaseAmounts(account, data, required);
			expect(Number(amounts.ms)).toBeGreaterThanOrEqual(row.min_ms);
			expect(Number(amounts.kb)).toBeGreaterThanOrEqual(row.min_kb);
			if (row.inc_ram_kb > 0) {
				// RAM top-ups run on Jungle 4 only (MANAGED_ACCOUNT_RAM_SUPPORTED); force it on here.
				expect(getAccountRequiresRAM(account, getAccountCurrentResources(data), true)).toBeTrue();
				expect(Number(getRamPurchaseBytes(account, data))).toBeGreaterThanOrEqual(
					row.min_ram_kb * 1000
				);
			}
		});
	}

	it('keeps the sponsor RAM payers liquid with bounded refills', () => {
		const topups = parseBalanceTopups(inventory.balanceTopups);
		expect(topups.map((t) => t.account)).toEqual(['fbrampay.gm', 'rammgrtest11']);
		for (const topup of topups) {
			expect(Number(topup.amount.units)).toBeLessThanOrEqual(Number(topup.dailyLimit.units));
		}
	});
});

describe('per-account failure alerts', () => {
	afterEach(() => {
		resetManageFailures();
		alerts.reset();
	});

	it('alerts after repeated failed top-ups for one account and clears on recovery', async () => {
		const session = { actor: 'rsfui4ahy.gm' } as unknown as Session;
		const context = {} as ManagerContext;
		const account = {
			account: 'nofixture.gm',
			min_ms: 5,
			min_kb: 5,
			inc_ms: 10,
			inc_kb: 10,
			max_fee: '0.2500 EOS'
		};
		for (let i = 0; i < 5; i++) await manageAccountResources(session, account, context);
		expect(alerts.isActive('manage-failed:nofixture.gm')).toBeFalse();
		await manageAccountResources(session, account, context);
		expect(alerts.isActive('manage-failed:nofixture.gm')).toBeTrue();
	});
});

describe('manager cycle', () => {
	it('checks managed balances once the payer can pay, before topping up accounts', async () => {
		const order: string[] = [];
		const { alerts: recording } = recordingAlerts();
		await runManagerCycle({
			getSession: async () => ({ actor: 'rsfui4ahy.gm' }) as unknown as Session,
			getContext: async () =>
				({ managedAccounts: [{ account: 'fbrampay.gm' }] }) as unknown as ManagerContext,
			getAccount: async () => accountData('rsfui4ahy.gm', { max: 10_000_000, used: 0 }),
			getOrders: async () => [],
			fundBalances: async () => {
				order.push('balances');
			},
			manageAccount: async (_m, account) => {
				order.push(account.account);
			},
			payerMinCpuUs: 1000,
			payerReserveUs: 1000,
			alerts: recording
		});
		expect(order).toEqual(['balances', 'fbrampay.gm']);
	});
});
