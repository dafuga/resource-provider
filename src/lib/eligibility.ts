import type { MatchAction, PolicyBucket } from '$lib/rules';

export interface EligibilityCheck {
	chain_id: string;
	account: string;
	gates: string[];
	actions: MatchAction[];
}

export interface EligibilityHookOptions {
	url: string;
	bearerToken?: string;
	timeoutMs?: number;
	fetcher?: typeof fetch;
}

interface EligibilityHookResponse {
	eligible_gates: string[];
}

export function getRequiredGates(buckets: PolicyBucket[]): string[] {
	return [
		...new Set(
			buckets.map((bucket) => bucket.gate?.trim()).filter((gate): gate is string => Boolean(gate))
		)
	].sort();
}

export async function requestEligibleGates(
	check: EligibilityCheck,
	options: EligibilityHookOptions
): Promise<Set<string>> {
	const requested = new Set(check.gates);
	if (requested.size === 0) {
		return new Set();
	}

	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (options.bearerToken) {
		headers.authorization = `Bearer ${options.bearerToken}`;
	}

	const response = await (options.fetcher ?? fetch)(options.url, {
		method: 'POST',
		headers,
		body: JSON.stringify({ ...check, gates: [...requested].sort() }),
		signal: AbortSignal.timeout(options.timeoutMs ?? 2000)
	});
	if (!response.ok) {
		throw new Error(`Eligibility hook rejected the request (${response.status}).`);
	}

	const payload = (await response.json()) as Partial<EligibilityHookResponse>;
	if (
		!Array.isArray(payload.eligible_gates) ||
		payload.eligible_gates.some((gate) => typeof gate !== 'string')
	) {
		throw new Error('Eligibility hook returned an invalid response.');
	}

	return new Set(payload.eligible_gates.filter((gate) => requested.has(gate)));
}
