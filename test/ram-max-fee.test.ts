import { describe, expect, it } from 'bun:test';

import inventory from '../deploy/jungle4-managed-accounts.json';

import { estimateRamCost, fitRamPurchase } from '$lib/wharf/resources';

// A rammarket where 10 KB costs about 2.05 EOS, as on live Jungle 4 on 27 Nov 2026.
const base = 10_000_000_000;
const quote = 2_039_800;
const maxFee = 5;

describe('per-purchase RAM max fee (q8hq9w)', () => {
	it('leaves a purchase that fits untouched', () => {
		const fit = fitRamPurchase(10_000, base, quote, maxFee);
		expect(fit.bytes).toBe(10_000);
		expect(fit.cost).toBeCloseTo(2.05, 2);
	});

	it('shrinks an over-limit purchase to the largest one that fits', () => {
		const fit = fitRamPurchase(30_000, base, quote, maxFee);
		expect(fit.cost).toBeLessThanOrEqual(maxFee);
		expect(fit.bytes).toBeLessThan(30_000);
		expect(estimateRamCost(fit.bytes + 1, base, quote)).toBeGreaterThan(maxFee);
	});

	it('buys nothing without a budget or a usable market', () => {
		expect(fitRamPurchase(30_000, base, quote, 0).bytes).toBe(0);
		expect(fitRamPurchase(30_000, NaN, quote, maxFee).bytes).toBe(0);
		expect(fitRamPurchase(30_000, base, NaN, maxFee).bytes).toBe(0);
		expect(fitRamPurchase(30_000, base, 0, maxFee).bytes).toBe(0);
	});

	for (const row of inventory.managed.filter((row) => row.inc_ram_kb > 0)) {
		it(`brings ${row.account} from 0 free RAM back to its floor in bounded purchases`, () => {
			const floor = row.min_ram_kb * 1000;
			let free = 0;
			let purchases = 0;
			while (free < floor && purchases < 100) {
				const wanted = row.inc_ram_kb * 1000 + floor - free;
				const fit = fitRamPurchase(wanted, base, quote, maxFee);
				expect(fit.bytes).toBeGreaterThan(0);
				expect(fit.cost).toBeLessThanOrEqual(maxFee);
				free += fit.bytes;
				purchases++;
			}
			expect(free).toBeGreaterThanOrEqual(floor);
		});
	}
});
