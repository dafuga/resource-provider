import { describe, expect, it } from 'bun:test';

import { getRequiredGates, requestEligibleGates } from '$lib/eligibility';

describe('external bucket eligibility', () => {
	it('deduplicates and sorts gate keys from candidate buckets', () => {
		expect(
			getRequiredGates([
				{ name: 'premium', priority: 1, limit_ms: 100, limit_kb: 100, gate: 'subscriber' },
				{ name: 'event', priority: 2, limit_ms: 50, limit_kb: 50, gate: 'event' },
				{ name: 'premium-fallback', priority: 3, limit_ms: 20, limit_kb: 20, gate: 'subscriber' },
				{ name: 'public', priority: 4, limit_ms: 5, limit_kb: 5 }
			])
		).toEqual(['event', 'subscriber']);
	});

	it('sends a generic account, action, and gate request with optional authentication', async () => {
		const requester = { actor: 'alice', permission: 'active' };
		const actions = [
			{
				account: 'game',
				name: 'play',
				authorization: [requester],
				data: { player: 'alice' }
			}
		];
		const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
			expect(init?.method).toBe('POST');
			expect(init?.headers).toEqual({
				'content-type': 'application/json',
				authorization: 'Bearer secret'
			});
			expect(JSON.parse(String(init?.body))).toEqual({
				chain_id: 'chain-id',
				account: 'alice',
				requester,
				gates: ['event', 'subscriber'],
				actions
			});
			return Response.json({ eligible_gates: ['subscriber', 'not-requested'] });
		}) as typeof fetch;

		await expect(
			requestEligibleGates(
				{
					chain_id: 'chain-id',
					account: 'alice',
					requester,
					gates: ['subscriber', 'event', 'subscriber'],
					actions
				},
				{ url: 'https://eligibility.example/check', bearerToken: 'secret', fetcher }
			)
		).resolves.toEqual(new Set(['subscriber']));
	});

	it('rejects failed and malformed hook responses', async () => {
		const requester = { actor: 'alice', permission: 'active' };
		const check = {
			chain_id: 'chain-id',
			account: 'alice',
			requester,
			gates: ['subscriber'],
			actions: [
				{
					account: 'game',
					name: 'play',
					authorization: [requester],
					data: { player: 'alice' }
				}
			]
		};
		await expect(
			requestEligibleGates(check, {
				url: 'https://eligibility.example/check',
				fetcher: (async () => new Response('unavailable', { status: 503 })) as typeof fetch
			})
		).rejects.toThrow('Eligibility hook rejected the request (503).');
		await expect(
			requestEligibleGates(check, {
				url: 'https://eligibility.example/check',
				fetcher: (async () => Response.json({ eligible_gates: 'subscriber' })) as typeof fetch
			})
		).rejects.toThrow('Eligibility hook returned an invalid response.');
	});
});
