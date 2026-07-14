export interface SubscriptionEntitlementOptions {
	nodeosApi: string;
	contract: string;
	scope: string;
	table: string;
	fetcher?: typeof fetch;
	now?: number;
}

interface PlanRow {
	owner: string;
	paid_until: string;
}

export function parseChainTime(value: string): number {
	const normalized = value.endsWith('Z') ? value : `${value}Z`;
	const seconds = Math.floor(Date.parse(normalized) / 1000);
	return Number.isFinite(seconds) ? seconds : 0;
}

export function transactionContractsAllowed(
	contracts: string[],
	allowedContracts: string[]
): boolean {
	const allowed = new Set(allowedContracts);
	return contracts.length > 0 && contracts.every((contract) => allowed.has(contract));
}

export async function hasActiveOnChainSubscription(
	account: string,
	options: SubscriptionEntitlementOptions
): Promise<boolean> {
	const fetcher = options.fetcher ?? fetch;
	const response = await fetcher(
		`${options.nodeosApi.replace(/\/$/, '')}/v1/chain/get_table_rows`,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				json: true,
				code: options.contract,
				scope: options.scope,
				table: options.table,
				lower_bound: account,
				limit: 1
			})
		}
	);
	if (!response.ok) {
		throw new Error(`Unable to read subscription entitlements (${response.status}).`);
	}
	const result = (await response.json()) as { rows?: PlanRow[] };
	const plan = result.rows?.find((row) => row.owner === account);
	const now = options.now ?? Math.floor(Date.now() / 1000);
	return Boolean(plan && parseChainTime(plan.paid_until) > now);
}
