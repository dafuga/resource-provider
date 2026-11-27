// Pure rules of the read-only coverage check (3vhnkz): the inventory matches the provider's
// managed list, every account is above its floors, and no lease can lapse unrenewed.
import { type Inventory, LIMIT_FIELDS, type ManagedLimits } from './inventory';

export interface Bandwidth {
	max: number | string;
	used: number | string;
	current_used?: number | string;
}

export interface ChainAccountData {
	cpu_limit: Bandwidth;
	net_limit: Bandwidth;
	cpu_weight: number | string;
	net_weight: number | string;
	ram_quota: number | string;
	ram_usage: number | string;
	core_liquid_balance?: string;
}

export interface LeaseOrder {
	cpu_weight: number | string;
	net_weight: number | string;
	expires: string;
}

export interface ProviderState {
	// Rows of GET /v2/resource/manager/list.
	managed: (ManagedLimits & { account: string })[];
	serviceActive: boolean;
}

export interface Observation {
	data: ChainAccountData;
	orders: LeaseOrder[];
}

export interface Finding {
	// Stable id used to de-duplicate notifications.
	key: string;
	message: string;
	// True when one sighting is enough. Otherwise it must persist across two runs, because
	// the manager normally tops a dipping account up within seconds.
	immediate: boolean;
}

export interface Floors {
	minCpuUs: number;
	minNetBytes: number;
	minRamBytes: number;
}

// Warn this long before a lease lapse that auto-renew will not prevent.
export const LEASE_WARNING_MINUTES = 6 * 60;
// The provider renews 120 min before expiry; a lease still unrenewed this close to expiry
// means renewal is failing.
export const RENEW_OVERDUE_MINUTES = 90;

const parseExpiry = (expires: string) =>
	Date.parse(expires.endsWith('Z') ? expires : `${expires}Z`);

const asset = (value?: string) => (value ? Number(value.split(' ')[0]) : 0);

const free = (limit: Bandwidth) => Number(limit.max) - Number(limit.current_used ?? limit.used);

const freeRam = (data: ChainAccountData) => Number(data.ram_quota) - Number(data.ram_usage);

const finding = (key: string, message: string, immediate = true): Finding => ({
	key,
	message,
	immediate
});

export function compareManagedList(inventory: Inventory, live: ProviderState['managed']) {
	const findings: Finding[] = [];
	const liveByName = new Map(live.map((row) => [row.account, row]));
	const known = new Set(inventory.managed.map((row) => row.account));
	for (const row of inventory.managed) {
		const actual = liveByName.get(row.account);
		if (!actual) {
			findings.push(
				finding(
					`unenrolled:${row.account}`,
					`${row.account} is in the inventory but NOT in the provider's managed list`
				)
			);
			continue;
		}
		const drift = LIMIT_FIELDS.filter((field) => String(actual[field]) !== String(row[field]));
		if (drift.length) {
			const detail = drift.map((f) => `${f} live ${actual[f]} / inventory ${row[f]}`).join(', ');
			findings.push(
				finding(
					`drift:${row.account}`,
					`${row.account} provider settings differ from the inventory: ${detail}`
				)
			);
		}
	}
	for (const row of live) {
		if (!known.has(row.account)) {
			findings.push(
				finding(
					`uninventoried:${row.account}`,
					`${row.account} is managed by the provider but missing from the inventory`
				)
			);
		}
	}
	return findings;
}

export function checkFloors(
	account: string,
	floors: Floors,
	gates: { cpu_us: number }[],
	data: ChainAccountData
) {
	const findings: Finding[] = [];
	const cpu = free(data.cpu_limit);
	const gate = Math.max(0, ...gates.filter((g) => cpu < g.cpu_us).map((g) => g.cpu_us));
	if (gate) {
		findings.push(
			finding(`cpu-gate:${account}`, `${account} has ${cpu} us CPU, below its ${gate} us app gate`)
		);
	}
	const low = (kind: string, have: number, floor: number, unit: string) => {
		if (floor > 0 && have < floor) {
			findings.push(
				finding(
					`${kind.toLowerCase()}-floor:${account}`,
					`${account} has ${have} ${unit} ${kind} free, below its floor of ${floor}`,
					false
				)
			);
		}
	};
	low('CPU', cpu, floors.minCpuUs, 'us');
	low('NET', free(data.net_limit), floors.minNetBytes, 'bytes');
	low('RAM', freeRam(data), floors.minRamBytes, 'bytes');
	return findings;
}

// The first moment at which the leases expired by then leave the account below its floor.
// Bandwidth scales with weight, so capacity after an expiry is max * remaining / total.
export function firstLapse(
	orders: LeaseOrder[],
	weight: 'cpu_weight' | 'net_weight',
	totalWeight: number,
	capacity: number,
	floor: number,
	now: number
): number | undefined {
	const upcoming = orders
		.filter((o) => Number(o[weight]) > 0 && parseExpiry(o.expires) > now)
		.sort((a, b) => parseExpiry(a.expires) - parseExpiry(b.expires));
	let remaining = totalWeight;
	for (const order of upcoming) {
		remaining -= Number(order[weight]);
		const left = totalWeight > 0 ? (capacity * Math.max(0, remaining)) / totalWeight : 0;
		if (left < floor) return parseExpiry(order.expires);
	}
	return undefined;
}

export function earliestExpiry(orders: LeaseOrder[], now: number): string | null {
	const times = orders.map((o) => parseExpiry(o.expires)).filter((t) => t > now);
	return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

export function checkLeases(
	account: string,
	floors: Floors,
	{ data, orders }: Observation,
	// Why auto-renew will not save this account; empty when it is covered.
	uncovered: string[],
	now: number
) {
	const findings: Finding[] = [];
	const kinds = [
		['CPU', 'cpu_weight', data.cpu_weight, data.cpu_limit.max, floors.minCpuUs],
		['NET', 'net_weight', data.net_weight, data.net_limit.max, floors.minNetBytes]
	] as const;
	for (const [kind, weight, total, capacity, floor] of kinds) {
		const at = firstLapse(orders, weight, Number(total), Number(capacity), floor, now);
		if (at === undefined || at - now > LEASE_WARNING_MINUTES * 60_000) continue;
		const reasons = [...uncovered];
		if (at - now <= RENEW_OVERDUE_MINUTES * 60_000) reasons.push('auto-renew is overdue');
		if (!reasons.length) continue;
		findings.push(
			finding(
				`lease:${account}:${kind}`,
				`${account} ${kind} lease expiring ${new Date(at).toISOString()} drops it below its floor; ${reasons.join('; ')}`
			)
		);
	}
	return findings;
}

export interface AccountReport {
	account: string;
	cpuUs: number;
	netBytes: number;
	ramBytes: number;
	liquid: string;
	earliestLeaseExpiry: string | null;
}

export interface CoverageReport {
	findings: Finding[];
	accounts: AccountReport[];
}

function checkProvider(
	inventory: Inventory,
	provider: ProviderState,
	payerData?: ChainAccountData
) {
	const findings: Finding[] = [];
	const payer = inventory.selfManaged[0];
	if (!provider.serviceActive) {
		findings.push(
			finding('provider-down', 'resource-provider.service is not active; nothing is being renewed')
		);
	}
	if (payerData && asset(payerData.core_liquid_balance) < asset(payer.min_balance)) {
		findings.push(
			finding(
				`payer-dry:${payer.account}`,
				`provider payer ${payer.account} holds ${payerData.core_liquid_balance}, below ${payer.min_balance}`
			)
		);
	}
	return findings;
}

function expectations(inventory: Inventory, enrolled: Set<string>) {
	const payer = inventory.selfManaged[0];
	return [
		...inventory.managed.map((row) => ({
			account: row.account,
			floors: {
				minCpuUs: Number(row.min_ms) * 1000,
				minNetBytes: Number(row.min_kb) * 1000,
				minRamBytes: Number(row.inc_ram_kb) > 0 ? Number(row.min_ram_kb) * 1000 : 0
			},
			gates: row.gates ?? [],
			enrolled: enrolled.has(row.account)
		})),
		{
			account: payer.account,
			floors: { minCpuUs: payer.min_ms * 1000, minNetBytes: 0, minRamBytes: 0 },
			gates: [],
			enrolled: true
		}
	];
}

// Accounts that buy players' RAM spend their own liquid EOS ("account=trigger/amount/daily").
function checkBalances(inventory: Inventory, observations: Map<string, Observation>) {
	const findings: Finding[] = [];
	for (const entry of inventory.balanceTopups.split(',')) {
		const [account, limits] = entry.split('=');
		const trigger = limits.split('/')[0];
		const data = observations.get(account)?.data;
		if (data && asset(data.core_liquid_balance) < asset(trigger)) {
			findings.push(
				finding(
					`balance-low:${account}`,
					`${account} holds ${data.core_liquid_balance ?? '0 EOS'}, below ${trigger}; it pays players' RAM`,
					false
				)
			);
		}
	}
	return findings;
}

export function checkCoverage(
	inventory: Inventory,
	provider: ProviderState,
	observations: Map<string, Observation>,
	now: number
): CoverageReport {
	const payerData = observations.get(inventory.selfManaged[0].account)?.data;
	const providerFindings = checkProvider(inventory, provider, payerData);
	const findings = [...compareManagedList(inventory, provider.managed), ...providerFindings];
	const accounts: AccountReport[] = [];
	const enrolled = new Set(provider.managed.map((row) => row.account));
	for (const row of expectations(inventory, enrolled)) {
		const observation = observations.get(row.account);
		if (!observation) {
			findings.push(
				finding(
					`unreadable:${row.account}`,
					`${row.account} could not be read from the chain`,
					false
				)
			);
			continue;
		}
		const { data, orders } = observation;
		accounts.push({
			account: row.account,
			cpuUs: free(data.cpu_limit),
			netBytes: free(data.net_limit),
			ramBytes: freeRam(data),
			liquid: data.core_liquid_balance ?? '0.0000 EOS',
			earliestLeaseExpiry: earliestExpiry(orders, now)
		});
		const gateUs = Math.max(0, ...row.gates.map((g) => g.cpu_us));
		const uncovered = [
			...(row.enrolled ? [] : ['not enrolled for auto-renew']),
			...providerFindings.map((f) => f.message)
		];
		findings.push(
			...checkFloors(row.account, row.floors, row.gates, data),
			...checkLeases(
				row.account,
				{ ...row.floors, minCpuUs: Math.max(row.floors.minCpuUs, gateUs) },
				observation,
				uncovered,
				now
			)
		);
	}
	findings.push(...checkBalances(inventory, observations));
	return { findings, accounts };
}
