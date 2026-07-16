import type { API } from '@wharfkit/antelope';
import { Int64 } from '@wharfkit/antelope';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Elysia } from 'elysia';

import { server } from '../src/provider';

import { setSetting, unsetSetting } from '$lib/settings';
import { checkResourceSufficiency } from '$lib/wharf/validation';
import { PROVIDER_ACCOUNT_NAME, PROVIDER_ACCOUNT_PERMISSION } from 'src/config';

const mockRequest =
	'esr://gmNgZGBY1mTC_MoglIGBIVzX5uxZRqAQGDBBaWeYABgAVcL4LK7-wSBaKSi1OL-0KDlVoaAovywzJbVIoSS1uEShpCgxrzgxuSQzPw-oBQA';

const mockRequestUsingCosigner = 'esr://AgABAACmgjQD6jBVAAAAVy08zc0BEDLOVyW36a0AAAAAqO0yMgABAAA';

const mockSigner = {
	actor: 'wharfkit1111',
	permission: 'active'
};

const mockRequestPayload = {
	signer: mockSigner,
	request: mockRequest
};

const transactionAuthorizedByAnotherAccount = {
	expiration: '2026-07-16T22:00:00',
	ref_block_num: 0,
	ref_block_prefix: 0,
	max_net_usage_words: 0,
	max_cpu_usage_ms: 0,
	delay_sec: 0,
	context_free_actions: [],
	actions: [
		{
			account: 'eosio.token',
			name: 'transfer',
			authorization: [{ actor: 'different111', permission: 'active' }],
			data: {
				from: 'different111',
				to: 'wharfkit1111',
				quantity: '0.0001 EOS',
				memo: ''
			}
		}
	],
	transaction_extensions: []
};

let app: Elysia;

function makeRequest(path: string, data: unknown) {
	return new Request(`http://localhost${path}`, {
		method: 'POST',
		body: JSON.stringify(data),
		headers: { 'Content-Type': 'application/json' }
	});
}

function accountWithAvailableResources(cpu: number, net: number): API.v1.AccountObject {
	return {
		cpu_limit: { max: Int64.from(cpu), current_used: Int64.from(0) },
		net_limit: { max: Int64.from(net), current_used: Int64.from(0) }
	} as API.v1.AccountObject;
}

describe('v1/resource_provider/request_transaction', () => {
	beforeAll(() => {
		setSetting('provider.require_resource_need', 'false');
		const instance = server();
		expect(instance).toBeDefined();
		app = instance!;
	});
	afterAll(() => {
		unsetSetting('provider.require_resource_need');
	});
	describe('signer validation', () => {
		it('requires signer', async () => {
			const request = makeRequest('/v1/resource_provider/request_transaction', {
				request: mockRequest
			});
			const response = await app.handle(request);
			expect(response.ok).toBeFalse();
		});
		it('requires actor value', async () => {
			const request = makeRequest('/v1/resource_provider/request_transaction', {
				signer: {
					actor: '',
					permission: 'active'
				},
				request: mockRequest
			});
			const response = await app.handle(request);
			expect(response.ok).toBeFalse();
		});
		it('requires permission value', async () => {
			const request = makeRequest('/v1/resource_provider/request_transaction', {
				signer: {
					actor: 'test.gm',
					permission: ''
				},
				request: mockRequest
			});
			const response = await app.handle(request);
			expect(response.ok).toBeFalse();
		});
		it('requires valid actor', async () => {
			const request = makeRequest('/v1/resource_provider/request_transaction', {
				signer: {
					actor: '9',
					permission: 'active'
				},
				request: mockRequest
			});
			const response = await app.handle(request);
			expect(response.ok).toBeFalse();
		});
		it('requires valid permission', async () => {
			const request = makeRequest('/v1/resource_provider/request_transaction', {
				signer: {
					actor: 'test',
					permission: '9'
				},
				request: mockRequest
			});
			const response = await app.handle(request);
			expect(response.ok).toBeFalse();
		});
		it('will not process identity request', async () => {
			const request = makeRequest('/v1/resource_provider/request_transaction', {
				signer: mockSigner,
				request: {
					signer: {
						actor: 'test',
						permission: 'active'
					},
					request:
						'esr://gz3MPU7DMBwF8KQFcQA4wH9sJRIndj4IXYIYAJWIoUiwFcc4xIprR0loBUdgQWLgKmwwsjAyUWbEwAxSJ1IJobc9vfczzK5hGPHk5v3V6AzypinrbYRYalPFcl3ZUqgCsZCEbkRCi4QMW95Whi1KaWoFbobPcRQE2KOdleX00fzXuhdXZ-r-y_t-cZ4XbxtciflD9CmN-eLpI_65XZ_emfEsp1VWiAaVlW4009LidQWuTWwMib4WUlLk2w70EsqEanSdD-BANVxCW8DRCE7BdcauPw77sFOWkp_wdNhyPgltEkBvuH-cHG6CFAWHPc4K3YfdvNITjlzSusvAiGa0En-X1Zrpkq9dKsH0lP8C'
				}
			});
			const response = await app.handle(request);
			expect(response.ok).toBeFalse();
		});
		it('will not process when signer equals cosigner', async () => {
			const request = makeRequest('/v1/resource_provider/request_transaction', {
				signer: {
					actor: PROVIDER_ACCOUNT_NAME,
					permission: PROVIDER_ACCOUNT_PERMISSION
				},
				request: mockRequest
			});
			const response = await app.handle(request);
			expect(response.ok).toBeFalse();
		});
		it('will not process when actions contain cosigner authorities', async () => {
			const request = makeRequest('/v1/resource_provider/request_transaction', {
				signer: mockSigner,
				request: mockRequestUsingCosigner
			});
			const response = await app.handle(request);
			expect(response.ok).toBeFalse();
		});
	});

	describe('request validation', () => {
		it('accepts request', async () => {
			const request = makeRequest('/v1/resource_provider/request_transaction', mockRequestPayload);
			const response = await app.handle(request);
			expect(response.ok).toBeTrue();
		});
		it('requires request/transaction/packed', async () => {
			const request = makeRequest('/v1/resource_provider/request_transaction', {
				signer: mockSigner
			});
			const response = await app.handle(request);
			expect(response.ok).toBeFalse();
		});
	});
	describe('resource need validation', () => {
		afterEach(() => {
			setSetting('provider.require_resource_need', 'false');
			unsetSetting('provider.min_cpu_us');
			unsetSetting('provider.min_net_bytes');
		});

		it('rejects cosigning when the requester already meets both resource thresholds', () => {
			setSetting('provider.require_resource_need', 'true');
			setSetting('provider.min_cpu_us', '50000');
			setSetting('provider.min_net_bytes', '50000');

			expect(() => checkResourceSufficiency(accountWithAvailableResources(50000, 50000))).toThrow(
				'Network resources not required by this account.'
			);
		});

		it('allows cosigning when either CPU or NET is below its threshold', () => {
			setSetting('provider.require_resource_need', 'true');
			setSetting('provider.min_cpu_us', '50000');
			setSetting('provider.min_net_bytes', '50000');

			expect(() =>
				checkResourceSufficiency(accountWithAvailableResources(49999, 50000))
			).not.toThrow();
			expect(() =>
				checkResourceSufficiency(accountWithAvailableResources(50000, 49999))
			).not.toThrow();
		});

		it("checks the requester's resources rather than another action authorizer", async () => {
			setSetting('provider.require_resource_need', 'true');
			const request = makeRequest('/v1/resource_provider/request_transaction', {
				signer: mockSigner,
				transaction: transactionAuthorizedByAnotherAccount
			});

			const response = await app.handle(request);
			const body = (await response.json()) as { message: string };

			expect(response.ok).toBeFalse();
			expect(body.message).toContain('Network resources not required by this account.');
		});
	});
	describe('appends cosigner noop', () => {
		it('appends a noop without adding a PowerUp action', async () => {
			const request = makeRequest('/v1/resource_provider/request_transaction', mockRequestPayload);
			const response = await app.handle(request);
			const body = (await response.json()) as {
				data: { request: [string, { actions: Array<{ account: string; name: string }> }] };
			};
			const actions = body.data.request[1].actions;

			expect(response.ok).toBeTrue();
			expect(actions[0]).toMatchObject({ account: 'greymassnoop', name: 'noop' });
			expect(actions.some((action) => action.name === 'powerup')).toBeFalse();
		});
	});
	it('reports usage per bucket', async () => {
		const response = await app.handle(
			new Request('http://localhost/v2/resource/provider/usage/wharfkit1111')
		);
		const body = (await response.json()) as { buckets: Array<{ bucket: string }> };
		expect(Array.isArray(body.buckets)).toBeTrue();
		expect(body.buckets.some((b) => b.bucket === 'wildcard')).toBeTrue();
	});
});
