import { API } from '@wharfkit/antelope';
import { Session } from '@wharfkit/session';
import { beforeEach, describe, expect, it } from 'bun:test';

import { accountData, recordingAlerts } from './helpers';

import { resetHealthState } from '$lib/health';
import { getLeaseRenewals, type PowerupOrder } from '$lib/wharf/leases';
import { runManagerCycle, type ManagerCycleDeps } from 'src/manager';
import type { ManagerContext } from 'src/manager/context';

const payer = { actor: 'rsfui4ahy.gm' } as unknown as Session;
const managedAccounts = ['5ip24l2kc.gm', 'rngoracle.gm', 'pigracing.gm'].map((account) => ({
	account,
	min_ms: 5000,
	min_kb: 5,
	inc_ms: 20000,
	inc_kb: 10,
	max_fee: '3.0000 EOS'
}));
const context = { managedAccounts } as unknown as ManagerContext;

function deps(payerStates: API.v1.AccountObject[], overrides: Partial<ManagerCycleDeps> = {}) {
	const managed: string[] = [];
	let rescues = 0;
	const { alerts, sent } = recordingAlerts();
	const states = [...payerStates];
	const cycle: ManagerCycleDeps = {
		getSession: async () => payer,
		getContext: async () => context,
		getAccount: async () => (states.length > 1 ? states.shift()! : states[0]),
		getOrders: async () => [],
		manageAccount: async (_m, account) => {
			managed.push(account.account);
		},
		rescuePayer: async () => {
			rescues++;
		},
		payerMinCpuUs: 5_000_000,
		payerReserveUs: 3000,
		alerts,
		...overrides
	};
	return { cycle, managed, rescues: () => rescues, alerts, sent };
}

beforeEach(() => resetHealthState());

describe('manager cycle with the payer out of CPU (Nov 14 12:07-16:29 UTC)', () => {
	it('rescues the payer first and skips managed accounts while it cannot pay', async () => {
		// Before: every managed-account powerup failed with "billed CPU time (249 us) is greater
		// than the maximum billable CPU time for the transaction (0 us)", 975 times.
		const dry = accountData('rsfui4ahy.gm', { max: 0, used: 0 });
		const t = deps([dry]);
		await runManagerCycle(t.cycle);
		expect(t.rescues()).toBe(1);
		expect(t.managed).toEqual([]);
		expect(t.alerts.isActive('payer-dry:rsfui4ahy.gm')).toBeTrue();
	});

	it('covers oracle signer 2 and every other account once the rescue lands', async () => {
		const dry = accountData('rsfui4ahy.gm', { max: 0, used: 0 });
		const rescued = accountData('rsfui4ahy.gm', { max: 23_000_000, used: 0 });
		const t = deps([dry, rescued]);
		await runManagerCycle(t.cycle);
		expect(t.rescues()).toBe(1);
		expect(t.managed).toEqual(['5ip24l2kc.gm', 'rngoracle.gm', 'pigracing.gm']);
	});

	it('does not rescue when self-management is disabled, and still skips', async () => {
		const dry = accountData('rsfui4ahy.gm', { max: 0, used: 0 });
		const t = deps([dry], { rescuePayer: undefined });
		await runManagerCycle(t.cycle);
		expect(t.managed).toEqual([]);
	});

	it('runs every managed account when the payer is healthy', async () => {
		const healthy = accountData('rsfui4ahy.gm', { max: 38_813_031, used: 16_923_045 });
		const t = deps([healthy]);
		await runManagerCycle(t.cycle);
		expect(t.rescues()).toBe(0);
		expect(t.managed.length).toBe(3);
		expect(t.sent).toEqual([]);
	});

	it('does not block managed accounts when the payer lookup itself fails', async () => {
		const t = deps([], {
			getAccount: async () => {
				throw new TypeError('getaddrinfo ETIMEOUT jungle4.greymass.com');
			}
		});
		await runManagerCycle(t.cycle);
		expect(t.managed.length).toBe(3);
	});

	it('alerts about low payer balance and attempts funding before self-rescue when lease lookup fails', async () => {
		const dry = accountData('rsfui4ahy.gm', { max: 0, used: 0 }, '0.0010 EOS');
		const order: string[] = [];
		const t = deps([dry], {
			getOrders: async () => {
				throw new Error('lease lookup unavailable');
			},
			fundPayer: async () => {
				order.push('fund');
			},
			rescuePayer: async () => {
				order.push('rescue');
			}
		});
		await runManagerCycle(t.cycle);
		expect(t.sent.map((payload) => payload.alert.key)).toContain('payer-balance:rsfui4ahy.gm');
		expect(order).toEqual(['fund', 'rescue']);
		expect(t.managed).toEqual([]);
	});

	it('alerts when self-management has stopped completing checks', async () => {
		const healthy = accountData('rsfui4ahy.gm', { max: 38_813_031, used: 0 });
		const t = deps([healthy], {
			selfStatus: () => ({
				enabled: true,
				startedAt: Date.now() - 60 * 60_000,
				lastCompletedAt: undefined
			})
		});
		await runManagerCycle(t.cycle);
		expect(t.alerts.isActive('self-stale')).toBeTrue();
	});
});

describe('payer renews its own CPU well before expiry', () => {
	// rsfui4ahy.gm's CPU order bought 2026-11-13 10:52:31 expired 2026-11-14 10:52:31.
	const orders: PowerupOrder[] = [
		{
			owner: 'rsfui4ahy.gm',
			cpu_weight: 901_235_233,
			net_weight: 0,
			expires: '2026-11-14T10:52:31'
		},
		{
			owner: 'rsfui4ahy.gm',
			cpu_weight: 0,
			net_weight: 53_861_636,
			expires: '2026-11-15T03:07:31'
		}
	];
	const at = (iso: string) => Date.parse(iso);

	it('the payer window (360 min) renews ~6h ahead; the managed default (120 min) would not yet', () => {
		expect(getLeaseRenewals(orders, at('2026-11-14T05:00:00Z'), 360).cpuRequired).toBeTrue();
		expect(getLeaseRenewals(orders, at('2026-11-14T05:00:00Z'), 120).cpuRequired).toBeFalse();
	});

	it('stops renewing once a same-size lease extends past the window', () => {
		const renewed = [
			...orders,
			{
				owner: 'rsfui4ahy.gm',
				cpu_weight: 901_235_233,
				net_weight: 0,
				expires: '2026-11-15T05:00:00'
			}
		];
		expect(getLeaseRenewals(renewed, at('2026-11-14T05:00:00Z'), 360).cpuRequired).toBeFalse();
	});
});
