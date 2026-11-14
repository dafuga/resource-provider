import { Asset, Int64 } from '@wharfkit/antelope';
import { beforeEach, describe, expect, it } from 'bun:test';

import { migrationData } from '$lib/db/migration-data.generated';
import { ManagedAccount } from '$lib/db/models/manager/account';
import { ramPurchases } from '$lib/db/models/manager/ram-purchases';
import { getRamDailyCap, ramWithinDailyCap } from '$lib/wharf/resources';

const pigracing = (ram_daily_max_fee?: number) =>
	ManagedAccount.from({
		account: 'pigracing.gm',
		min_ms: Int64.from(5),
		min_kb: Int64.from(5),
		min_ram_kb: Int64.from(15),
		inc_ms: Int64.from(10),
		inc_kb: Int64.from(10),
		inc_ram_kb: Int64.from(10),
		max_fee: Asset.from('0.2500 EOS'),
		...(ram_daily_max_fee === undefined ? {} : { ram_daily_max_fee })
	});

beforeEach(async () => {
	await ramPurchases.reset();
});

describe('per-account RAM top-up cap', () => {
	it('uses the account cap, falling back to the default when unset or 0', () => {
		expect(getRamDailyCap(pigracing(5), 0)).toBe(5);
		expect(getRamDailyCap(pigracing(0), 20)).toBe(20);
		expect(getRamDailyCap(pigracing(), 20)).toBe(20);
		expect(getRamDailyCap(pigracing(), 0)).toBe(0);
		expect(pigracing().toJSON().ram_daily_max_fee).toBe(0);
		expect(pigracing(5).toJSON().ram_daily_max_fee).toBe(5);
	});

	it('stops the hourly pigracing.gm top-ups once its daily cap is reached (Nov 13: ~53 EOS)', async () => {
		// Nov 13: 24 top-ups of ~2.2 EOS each, paid by the oracle signer.
		const cap = getRamDailyCap(pigracing(5), 0);
		const start = Date.parse('2026-11-13T00:36:00Z');
		let bought = 0;
		for (let hour = 0; hour < 24; hour++) {
			const now = start + hour * 3600_000;
			const spent = await ramPurchases.getSpentLastDay('pigracing.gm', now);
			if (ramWithinDailyCap(spent, 2.2, cap)) {
				await ramPurchases.recordPurchase('pigracing.gm', 10_000, 2.2, now);
				bought++;
			}
		}
		expect(bought).toBe(2);
		const spentNextDay = await ramPurchases.getSpentLastDay(
			'pigracing.gm',
			start + 24 * 3600_000 + 60_000
		);
		expect(spentNextDay).toBeCloseTo(2.2, 5);
	});

	it('does not cap when no cap is configured', () => {
		expect(ramWithinDailyCap(1_000, 2.2, 0)).toBeTrue();
	});

	it('keeps spend per account', async () => {
		const now = Date.parse('2026-11-14T12:00:00Z');
		await ramPurchases.recordPurchase('pigracing.gm', 10_000, 2.2, now);
		expect(await ramPurchases.getSpentLastDay('pigcare.gm', now)).toBe(0);
	});

	it('ships an additive migration for the cap column and ledger table', () => {
		const sql = migrationData['0008_ram_daily_cap.sql'];
		expect(sql).toContain('CREATE TABLE `ram_purchases`');
		expect(sql).toContain('ALTER TABLE `accounts` ADD `ram_daily_max_fee` real DEFAULT 0 NOT NULL');
		expect(sql).not.toMatch(/DROP|DELETE/);
	});
});
