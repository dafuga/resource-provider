import { describe, expect, it } from 'bun:test';

import {
	type ChainAccountData,
	checkCoverage,
	type LeaseOrder,
	type Observation,
	type ProviderState
} from '$lib/coverage/check';
import { inventory, LIMIT_FIELDS } from '$lib/coverage/inventory';
import { findUnknownAccounts } from '$lib/coverage/scan';

const NOW = Date.parse('2026-11-26T12:00:00Z');
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString().slice(0, 19);

const limit = (available: number) => ({ max: available, used: 0, current_used: 0 });

function healthy(): ChainAccountData {
	return {
		cpu_limit: limit(50_000_000),
		net_limit: limit(50_000_000),
		cpu_weight: 1000,
		net_weight: 1000,
		ram_quota: 5_000_000,
		ram_usage: 0,
		core_liquid_balance: '500.0000 EOS'
	};
}

// Nearly all of the weight is one lease expiring in `hours`.
const leased = (hours: number): LeaseOrder[] => [
	{ cpu_weight: 1000, net_weight: 0, expires: at(hours) }
];

function provider(): ProviderState {
	return {
		serviceActive: true,
		managed: inventory.managed.map((row) => ({
			account: row.account,
			...(Object.fromEntries(LIMIT_FIELDS.map((f) => [f, row[f]])) as Record<
				(typeof LIMIT_FIELDS)[number],
				number | string
			>)
		}))
	};
}

function chain(change: Record<string, Partial<Observation>> = {}) {
	return new Map<string, Observation>(
		[...inventory.managed, ...inventory.selfManaged].map((row) => [
			row.account,
			{ data: healthy(), orders: [], ...change[row.account] }
		])
	);
}

const keys = (state = provider(), observations = chain()) =>
	checkCoverage(inventory, state, observations, NOW).findings.map((f) => f.key);

const without = (account: string) => {
	const state = provider();
	state.managed = state.managed.filter((row) => row.account !== account);
	return state;
};

describe('inventory', () => {
	it('records role, payers, limits and signing location for every account', () => {
		for (const row of inventory.managed) {
			expect(row.role).toBeTruthy();
			expect(row.pays.cpu_net).toBeTruthy();
			expect(row.pays.ram).toBeTruthy();
			for (const field of LIMIT_FIELDS) expect(row[field]).toBeDefined();
			expect(row.authority.length).toBeGreaterThan(0);
		}
	});

	it('never carries key material', () => {
		const text = JSON.stringify(inventory);
		expect(text).not.toMatch(/PVT_(K1|R1)_|\b5[HJK][1-9A-HJ-NP-Za-km-z]{49}\b/);
		expect(text).not.toMatch(/PUB_(K1|R1)_|\bEOS[1-9A-HJ-NP-Za-km-z]{50}\b/);
	});

	it('keeps the fbrampay.gm floor above both app CPU gates', () => {
		const row = inventory.managed.find((r) => r.account === 'fbrampay.gm')!;
		expect(row.gates!.map((g) => g.cpu_us)).toEqual([30_000, 100_000]);
		expect(Number(row.min_ms) * 1000).toBeGreaterThanOrEqual(200_000);
	});
});

describe('coverage check', () => {
	it('passes when the provider list and the chain match the inventory', () => {
		expect(keys()).toEqual([]);
	});

	it('fails on an unenrolled, an uninventoried and a weakened account', () => {
		const state = without('fatebound.gm');
		state.managed.push({ ...state.managed[0], account: 'newthing.gm' });
		state.managed[0] = { ...state.managed[0], min_ms: 1 };
		expect(keys(state)).toEqual([
			`drift:${inventory.managed[0].account}`,
			'unenrolled:fatebound.gm',
			'uninventoried:newthing.gm'
		]);
	});

	it('fails below an app CPU gate at once, and below a floor after two sightings', () => {
		const data = { ...healthy(), cpu_limit: limit(99_999) };
		const report = checkCoverage(inventory, provider(), chain({ 'fbrampay.gm': { data } }), NOW);
		expect(report.findings.map((f) => [f.key, f.immediate])).toEqual([
			['cpu-gate:fbrampay.gm', true],
			['cpu-floor:fbrampay.gm', false]
		]);
	});

	it('fails on low RAM and on a RAM payer short of liquid EOS', () => {
		const ram = { ...healthy(), ram_usage: 4_999_000 };
		const poor = { ...healthy(), core_liquid_balance: '4.0000 EOS' };
		expect(
			keys(provider(), chain({ 'pigracing.gm': { data: ram }, rammgrtest11: { data: poor } }))
		).toEqual(['ram-floor:pigracing.gm', 'balance-low:rammgrtest11']);
	});

	it('warns 6h before a lapse that auto-renew will not prevent', () => {
		const soon = chain({ 'fatebound.gm': { orders: leased(5.9) } });
		expect(keys(without('fatebound.gm'), soon)).toContain('lease:fatebound.gm:CPU');
		const later = chain({ 'fatebound.gm': { orders: leased(6.1) } });
		expect(keys(without('fatebound.gm'), later)).not.toContain('lease:fatebound.gm:CPU');
	});

	it('trusts auto-renew for an enrolled account until renewal is overdue', () => {
		expect(keys(provider(), chain({ 'fatebound.gm': { orders: leased(5) } }))).toEqual([]);
		expect(keys(provider(), chain({ 'fatebound.gm': { orders: leased(1.4) } }))).toEqual([
			'lease:fatebound.gm:CPU'
		]);
	});

	it('does not trust auto-renew when the payer is dry or the service is down', () => {
		const dry = { data: { ...healthy(), core_liquid_balance: '1.0000 EOS' } };
		const observations = chain({ 'rsfui4ahy.gm': dry, 'fatebound.gm': { orders: leased(5) } });
		expect(keys(provider(), observations)).toEqual([
			'payer-dry:rsfui4ahy.gm',
			'lease:fatebound.gm:CPU'
		]);
		const down = { ...provider(), serviceActive: false };
		expect(keys(down, chain({ 'fatebound.gm': { orders: leased(5) } }))).toEqual([
			'provider-down',
			'lease:fatebound.gm:CPU'
		]);
	});

	it('ignores an expiring lease the account does not depend on, and reports the earliest', () => {
		const orders = [{ cpu_weight: 1, net_weight: 0, expires: at(1) }];
		const report = checkCoverage(inventory, provider(), chain({ 'fbrampay.gm': { orders } }), NOW);
		expect(report.findings).toEqual([]);
		expect(report.accounts[0].earliestLeaseExpiry).toBe(`${at(1)}.000Z`);
	});

	it('does not pass an account it could not read', () => {
		const observations = chain();
		observations.delete('fbrampay.gm');
		expect(keys(provider(), observations)).toEqual(['unreadable:fbrampay.gm']);
	});
});

describe('app config scan', () => {
	const scan = (path: string, content: string) => [
		...findUnknownAccounts(inventory, [{ repo: 'dafuga/app', path, content }]).keys()
	];

	it('fails on a new account in a wrangler or env file', () => {
		expect(scan('wrangler.toml', 'GAME_CONTRACT = "rngdice.gm"')).toEqual(['rngdice.gm']);
		expect(scan('workers/keeper/wrangler.toml', 'KEEPER_ACTOR = "dicekeeper11"')).toEqual([
			'dicekeeper11'
		]);
		expect(scan('wrangler.sponsor.toml', 'SPONSOR_PAYER = "newpayer.gm@txsponsor"')).toEqual([
			'newpayer.gm'
		]);
		expect(scan('.env.production', 'VITE_RESOURCE_PAYER=otherpayer11@noop')).toEqual([
			'otherpayer11'
		]);
		expect(scan('wrangler.jsonc', '"RAM_SPONSOR": "ramsponsor22",')).toEqual(['ramsponsor22']);
	});

	it('fails on a new account named in app source', () => {
		expect(scan('src/lib/config/contracts.ts', "export const C = 'rngdice.gm';")).toEqual([
			'rngdice.gm'
		]);
	});

	it('excuses documented examples in source only', () => {
		expect(scan('src/bot/cli.ts', '// BOT_ACCOUNT=other.gm')).toEqual([]);
		expect(scan('wrangler.toml', 'BOT_ACCOUNT = "other.gm"')).toEqual(['other.gm']);
	});

	it('ignores known, system, placeholder and non-account values', () => {
		const config = [
			'RAM_SPONSOR = "rammgrtest11"',
			'PUBLIC_TOKEN_CONTRACT=eosio.token',
			'PUBLIC_CONTRACT_ACCOUNT=yourcontract',
			'RAM_ACCOUNT_LIFETIME_UNITS = "141534"',
			'name = "rng-fatebound"',
			'URL = "https://example.gm.dev"'
		].join('\n');
		expect(scan('wrangler.toml', config)).toEqual([]);
		expect(scan('src/lib/a.test.ts', "'fixture.gm'")).toEqual([]);
	});
});
