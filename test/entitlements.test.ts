import { describe, expect, it } from 'bun:test';

import {
	hasActiveOnChainSubscription,
	parseChainTime,
	transactionContractsAllowed
} from '$lib/entitlements';

describe('on-chain subscription entitlements', () => {
	it('parses Antelope time points as UTC', () => {
		expect(parseChainTime('2030-01-01T00:00:00')).toBe(1893456000);
	});

	it('requires every original action to target an allowed game contract', () => {
		expect(transactionContractsAllowed(['rngfront.gm'], ['rngfront.gm'])).toBeTrue();
		expect(
			transactionContractsAllowed(['rngfront.gm', 'eosio.token'], ['rngfront.gm'])
		).toBeFalse();
		expect(transactionContractsAllowed([], ['rngfront.gm'])).toBeFalse();
	});

	it('accepts an unexpired plan belonging to the signer', async () => {
		const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			expect(body).toMatchObject({
				code: 'rngfront.gm',
				scope: 'rngfront.gm',
				table: 'plans',
				lower_bound: 'player.gm'
			});
			return Response.json({
				rows: [{ owner: 'player.gm', paid_until: '2030-01-01T00:00:00' }]
			});
		}) as typeof fetch;
		await expect(
			hasActiveOnChainSubscription('player.gm', {
				nodeosApi: 'https://jungle.example',
				contract: 'rngfront.gm',
				scope: 'rngfront.gm',
				table: 'plans',
				fetcher,
				now: 1890000000
			})
		).resolves.toBeTrue();
	});

	it('rejects expired or differently owned plans', async () => {
		const fetcher = (async () =>
			Response.json({
				rows: [{ owner: 'other.gm', paid_until: '2030-01-01T00:00:00' }]
			})) as typeof fetch;
		await expect(
			hasActiveOnChainSubscription('player.gm', {
				nodeosApi: 'https://jungle.example',
				contract: 'rngfront.gm',
				scope: 'rngfront.gm',
				table: 'plans',
				fetcher,
				now: 1890000000
			})
		).resolves.toBeFalse();
	});

	it('fails closed when the chain table cannot be read', async () => {
		const fetcher = (async () => new Response('unavailable', { status: 503 })) as typeof fetch;
		await expect(
			hasActiveOnChainSubscription('player.gm', {
				nodeosApi: 'https://jungle.example',
				contract: 'rngfront.gm',
				scope: 'rngfront.gm',
				table: 'plans',
				fetcher
			})
		).rejects.toThrow('Unable to read subscription entitlements (503).');
	});
});
