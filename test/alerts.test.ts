import { beforeEach, describe, expect, it } from 'bun:test';

import { accountData, recordingAlerts } from './helpers';

import { Alerts } from '$lib/alerts';
import { checkAccountHealth, checkSelfManagementHeartbeat, resetHealthState } from '$lib/health';
import type { PowerupOrder } from '$lib/wharf/leases';

beforeEach(() => resetHealthState());

describe('Alerts', () => {
	it('logs and posts a webhook payload, throttles repeats, then resolves', async () => {
		let now = Date.parse('2026-11-14T09:52:31Z');
		const { alerts, sent } = recordingAlerts(() => now);
		expect(
			await alerts.raise('cpu-low:rsfui4ahy.gm', 'payer low', { account: 'rsfui4ahy.gm' })
		).toBe(true);
		expect(sent[0].text).toBe('[resource-provider] ALERT: payer low');
		expect(sent[0].content).toBe(sent[0].text);
		expect(sent[0].alert).toMatchObject({ key: 'cpu-low:rsfui4ahy.gm', status: 'firing' });

		now += 10 * 60_000;
		expect(await alerts.raise('cpu-low:rsfui4ahy.gm', 'payer low')).toBe(false);
		now += 25 * 60_000;
		expect(await alerts.raise('cpu-low:rsfui4ahy.gm', 'payer low')).toBe(true);

		expect(await alerts.resolve('cpu-low:rsfui4ahy.gm', 'payer ok')).toBe(true);
		expect(await alerts.resolve('cpu-low:rsfui4ahy.gm', 'payer ok')).toBe(false);
		expect(sent.map((p) => p.alert.status)).toEqual(['firing', 'firing', 'resolved']);
	});

	it('never throws when the webhook fails, and works without a webhook', async () => {
		const failing = new Alerts({
			webhookUrl: 'https://hooks.example.test/rp',
			send: async () => {
				throw new Error('webhook responded 500');
			}
		});
		expect(await failing.raise('k', 'message')).toBe(true);
		const logOnly = new Alerts({ webhookUrl: undefined });
		expect(await logOnly.raise('k', 'message')).toBe(true);
	});
});

describe('checkAccountHealth', () => {
	const cpuOrder: PowerupOrder = {
		owner: 'rsfui4ahy.gm',
		cpu_weight: 901_235_233,
		net_weight: 0,
		expires: '2026-11-14T10:52:31'
	};
	const healthyPayer = accountData('rsfui4ahy.gm', { max: 23_000_000, used: 17_000_000 });

	it('warns ~1h before the payer lease expires unrenewed (Nov 14: 09:52, stall at 12:07)', async () => {
		const { alerts, sent } = recordingAlerts();
		await checkAccountHealth(healthyPayer, {
			role: 'payer',
			minCpuUs: 5_000_000,
			orders: [cpuOrder],
			now: Date.parse('2026-11-14T08:00:00Z'),
			alerts
		});
		expect(sent).toEqual([]);
		await checkAccountHealth(healthyPayer, {
			role: 'payer',
			minCpuUs: 5_000_000,
			orders: [cpuOrder],
			now: Date.parse('2026-11-14T09:55:00Z'),
			alerts
		});
		expect(sent.length).toBe(1);
		expect(sent[0].alert.key).toBe('lease-expiring:rsfui4ahy.gm');
		expect(sent[0].text).toContain('CPU lease expires within 60 min');
	});

	it('alerts on CPU below minimum only after the grace period, and resolves on recovery', async () => {
		const { alerts } = recordingAlerts();
		const low = accountData('5ip24l2kc.gm', { max: 4_000_000, used: 0 });
		const start = Date.parse('2026-11-14T12:00:00Z');
		const check = (data = low, now = start) =>
			checkAccountHealth(data, {
				role: 'managed',
				minCpuUs: 5_000_000,
				orders: [],
				now,
				alerts,
				cpuGraceSeconds: 120
			});
		await check();
		await check(low, start + 60_000);
		expect(alerts.isActive('cpu-low:5ip24l2kc.gm')).toBeFalse();
		await check(low, start + 120_000);
		expect(alerts.isActive('cpu-low:5ip24l2kc.gm')).toBeTrue();
		await check(accountData('5ip24l2kc.gm', { max: 25_000_000, used: 0 }), start + 130_000);
		expect(alerts.isActive('cpu-low:5ip24l2kc.gm')).toBeFalse();
	});

	it('alerts when the payer balance is low, but not for managed accounts', async () => {
		const { alerts } = recordingAlerts();
		const poor = accountData('rsfui4ahy.gm', { max: 23_000_000, used: 0 }, '42.0000 EOS');
		await checkAccountHealth(poor, {
			role: 'payer',
			minCpuUs: 1,
			orders: [],
			alerts,
			minBalance: 100
		});
		expect(alerts.isActive('payer-balance:rsfui4ahy.gm')).toBeTrue();

		const poorManaged = accountData('5ip24l2kc.gm', { max: 23_000_000, used: 0 }, '0.3252 EOS');
		await checkAccountHealth(poorManaged, {
			role: 'managed',
			minCpuUs: 1,
			orders: [],
			alerts,
			minBalance: 100
		});
		expect(alerts.isActive('payer-balance:5ip24l2kc.gm')).toBeFalse();
	});
});

describe('checkSelfManagementHeartbeat', () => {
	it('alerts when self-management goes quiet and resolves when it is back', async () => {
		const { alerts } = recordingAlerts();
		const now = Date.parse('2026-11-14T06:30:00Z');
		await checkSelfManagementHeartbeat(undefined, now - 14 * 60_000, {
			now,
			alerts,
			staleMinutes: 5
		});
		expect(alerts.isActive('self-stale')).toBeTrue();
		await checkSelfManagementHeartbeat(now - 20_000, now - 14 * 60_000, {
			now,
			alerts,
			staleMinutes: 5
		});
		expect(alerts.isActive('self-stale')).toBeFalse();
	});
});
