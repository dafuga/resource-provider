import { beforeAll, describe, expect, it, spyOn } from 'bun:test';
import type { Elysia, Static } from 'elysia';

import { server } from '../src/provider';

import type { v1ResponseSuccess } from '$api/v1/types';
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

let app: Elysia;

const cosigningRpcPaths = [
	'/v1/chain/get_account',
	'/v1/chain/get_info',
	'/v1/chain/get_raw_abi',
	'/v1/chain/compute_transaction'
];

function traceRpcRequests(failingPath?: string) {
	const fixtureFetch = globalThis.fetch;
	const paths: string[] = [];
	const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
		Object.assign(
			async (...[input, init]: Parameters<typeof fetch>) => {
				const url = input instanceof Request ? input.url : String(input);
				const path = new URL(url).pathname;
				paths.push(path);
				if (path === failingPath) {
					return Response.json(
						{ code: 503, message: 'Synthetic node unavailable' },
						{ status: 503 }
					);
				}
				return fixtureFetch(input, init);
			},
			{ preconnect: fixtureFetch.preconnect }
		)
	);
	return { paths, restore: () => fetchSpy.mockRestore() };
}

function makeRequest(path: string, data: unknown) {
	return new Request(`http://localhost${path}`, {
		method: 'POST',
		body: JSON.stringify(data),
		headers: { 'Content-Type': 'application/json' }
	});
}

describe('v1/resource_provider/request_transaction', () => {
	beforeAll(() => {
		const instance = server();
		expect(instance).toBeDefined();
		app = instance!;
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
		it('returns a cosigned transaction without broadcasting it', async () => {
			const rpc = traceRpcRequests();
			try {
				const request = makeRequest(
					'/v1/resource_provider/request_transaction',
					mockRequestPayload
				);
				const response = await app.handle(request);
				const body = (await response.json()) as Static<typeof v1ResponseSuccess>;
				expect(response.status).toBe(200);
				expect(body.code).toBe(200);
				expect(body.data.request[0]).toBe('transaction');
				expect(body.data.signatures).toHaveLength(1);
				expect(rpc.paths).toContain('/v1/chain/compute_transaction');
				expect(rpc.paths.every((path) => cosigningRpcPaths.includes(path))).toBeTrue();
			} finally {
				rpc.restore();
			}
		});
		it.each(['/v1/chain/get_account', '/v1/chain/compute_transaction'])(
			'rejects an upstream 503 from %s without broadcasting or returning signatures',
			async (failingPath) => {
				const rpc = traceRpcRequests(failingPath);
				try {
					const request = makeRequest(
						'/v1/resource_provider/request_transaction',
						mockRequestPayload
					);
					const response = await app.handle(request);
					const body = (await response.json()) as { message: string; data?: unknown };
					expect(rpc.paths).toContain(failingPath);
					expect(response.status).toBe(500);
					expect(body.message).toContain(
						failingPath === '/v1/chain/get_account'
							? 'Unable to retrieve account data'
							: 'HTTP 503 at /v1/chain/compute_transaction'
					);
					expect(body.data).toBeUndefined();
					expect(rpc.paths.every((path) => cosigningRpcPaths.includes(path))).toBeTrue();
				} finally {
					rpc.restore();
				}
			}
		);
		it('requires request/transaction/packed', async () => {
			const request = makeRequest('/v1/resource_provider/request_transaction', {
				signer: mockSigner
			});
			const response = await app.handle(request);
			expect(response.ok).toBeFalse();
		});
	});
	describe('appends cosigner noop', () => {
		it('appends noop action to request', async () => {
			const request = makeRequest('/v1/resource_provider/request_transaction', mockRequestPayload);
			const response = await app.handle(request);
			expect(response.ok).toBeTrue();
		});
	});
});
