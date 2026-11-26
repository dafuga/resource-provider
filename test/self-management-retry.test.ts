import { describe, expect, it } from 'bun:test';

import { recordingAlerts } from './helpers';

import { backoffDelayMs, retryUntilSuccess, singleFlight, withTimeout } from '$lib/retry';
import { cacheSession } from '$lib/wharf/session';
import { AccountConfigurationError, startSelfManagement } from 'src/self-management';

const dnsTimeout = () => new TypeError('getaddrinfo ETIMEOUT jungle4.greymass.com');

describe('self-management startup (Nov 14 06:16 UTC outage)', () => {
	it('keeps retrying a DNS timeout and then schedules the checks', async () => {
		// Before: the first failure returned without scheduling the cron; the payer then went
		// unmanaged until a manual restart ten hours later.
		let attempts = 0;
		const delays: number[] = [];
		const scheduled: Array<() => Promise<void>> = [];
		let runs = 0;
		const { alerts } = recordingAlerts();
		await startSelfManagement({
			verify: async () => {
				attempts++;
				if (attempts <= 2) throw dnsTimeout();
			},
			run: async () => {
				runs++;
			},
			schedule: (job) => scheduled.push(job),
			sleep: async (ms) => {
				delays.push(ms);
			},
			alerts
		});
		expect(attempts).toBe(3);
		expect(delays).toEqual([1000, 2000]);
		expect(scheduled.length).toBe(1);
		expect(runs).toBe(1);
		expect(alerts.isActive('self-verify')).toBeFalse();
	});

	it('alerts after repeated failures, never gives up, and resolves once verified', async () => {
		let attempts = 0;
		const delays: number[] = [];
		const { alerts, sent } = recordingAlerts();
		const scheduled: Array<() => Promise<void>> = [];
		await startSelfManagement({
			verify: async () => {
				attempts++;
				if (attempts <= 10) throw dnsTimeout();
			},
			run: async () => {},
			schedule: (job) => scheduled.push(job),
			sleep: async (ms) => {
				delays.push(ms);
			},
			maxRetrySeconds: 60,
			alerts
		});
		expect(attempts).toBe(11);
		expect(Math.max(...delays)).toBe(60_000);
		expect(scheduled.length).toBe(1);
		expect(sent.map((p) => p.alert.status)).toEqual(['firing', 'resolved']);
		expect(sent[0].alert.key).toBe('self-verify');
		expect(sent[0].text).toContain('getaddrinfo ETIMEOUT');
	});

	it('alerts immediately on a misconfigured permission but keeps retrying', async () => {
		let attempts = 0;
		const { alerts, sent } = recordingAlerts();
		await startSelfManagement({
			verify: async () => {
				attempts++;
				if (attempts === 1) throw new AccountConfigurationError('permission "manager" not found');
			},
			run: async () => {},
			schedule: () => {},
			sleep: async () => {},
			alerts
		});
		expect(attempts).toBe(2);
		expect(sent[0].alert.status).toBe('firing');
	});
});

describe('retry helpers', () => {
	it('backs off exponentially up to the cap', () => {
		expect([1, 2, 3, 4, 8].map((a) => backoffDelayMs(a, 1000, 10_000))).toEqual([
			1000, 2000, 4000, 8000, 10_000
		]);
	});

	it('retryUntilSuccess returns the first successful result', async () => {
		let calls = 0;
		const result = await retryUntilSuccess(
			async () => {
				calls++;
				if (calls < 3) throw new Error('rpc timeout');
				return 'ok';
			},
			{ sleep: async () => {} }
		);
		expect(result).toBe('ok');
		expect(calls).toBe(3);
	});

	it('withTimeout releases a hung call so a protected cron can run again', async () => {
		const hung = new Promise<void>(() => {});
		expect(withTimeout(hung, 20, 'Self-management check')).rejects.toThrow('timed out after 20ms');
	});

	it('singleFlight shares one run between concurrent callers (duplicate startup powerup)', async () => {
		let executions = 0;
		let release!: () => void;
		const run = singleFlight(async () => {
			executions++;
			await new Promise<void>((resolve) => (release = resolve));
		});
		const first = run();
		const second = run();
		release();
		await Promise.all([first, second]);
		expect(executions).toBe(1);
		const third = run();
		release();
		await third;
		expect(executions).toBe(2);
	});

	it('does not cache a failed session, so the next call retries', async () => {
		let cached: Promise<unknown> | null = null;
		let calls = 0;
		const getAccount = async () => {
			calls++;
			if (calls === 1) throw dnsTimeout();
			return { account: 'rsfui4ahy.gm', permission: 'manager', key: 'unused' };
		};
		const set = (value: Promise<never> | null) => (cached = value);
		const attempt = () =>
			cacheSession(cached as never, set as never, getAccount as never).catch((e) => e);
		expect(String(await attempt())).toContain('getaddrinfo');
		expect(cached).toBeNull();
		expect(calls).toBe(1);
	});
});
