import { Action, Transaction } from '@wharfkit/antelope';
import { describe, expect, it } from 'bun:test';

import { usageDatabase } from '../src/lib/db/models/provider/usage';
import { withPrepaidRam } from '../src/lib/wharf/actions/ram';
import { planSponsoredRam } from '../src/lib/wharf/sponsored-ram';

const requester = 'player.gm';
const gameAction = (account = 'rngfront.gm', actor = requester) => ({
	account,
	name: 'joinworld',
	authorization: [{ actor }]
});
const policy = {
	gameContract: 'rngfront.gm',
	sponsor: 'rngfront.gm',
	maxBytes: 16_384
};

describe('game-funded player RAM', () => {
	it('buys RAM for the player from the game sponsor when gameplay is short', () => {
		expect(planSponsoredRam(requester, [gameAction()], requester, 2048, policy)).toEqual({
			payer: 'rngfront.gm',
			receiver: requester,
			bytes: 2048
		});
	});

	it('does not fund unrelated or mixed transactions', () => {
		expect(
			planSponsoredRam(requester, [gameAction('other.gm')], requester, 2048, policy)
		).toBeNull();
		expect(
			planSponsoredRam(requester, [gameAction(), gameAction('other.gm')], requester, 2048, policy)
		).toBeNull();
		expect(
			planSponsoredRam(requester, [gameAction('rngfront.gm', 'other.gm')], requester, 2048, policy)
		).toBeNull();
	});

	it('rejects a shortage on another payer or an excessive purchase', () => {
		expect(() => planSponsoredRam(requester, [gameAction()], 'other.gm', 2048, policy)).toThrow();
		expect(() => planSponsoredRam(requester, [gameAction()], requester, 16_385, policy)).toThrow();
	});

	it('enforces both player and service-wide rolling budgets', async () => {
		await usageDatabase.resetAllUsage();
		expect(usageDatabase.reserveRamSponsorship(requester, 1024, 2048, 3072)).toBe(true);
		expect(usageDatabase.reserveRamSponsorship(requester, 1500, 2048, 3072)).toBe(false);
		expect(usageDatabase.reserveRamSponsorship('second.gm', 2048, 2048, 3072)).toBe(true);
		expect(usageDatabase.reserveRamSponsorship('third.gm', 1, 2048, 3072)).toBe(false);
	});

	it('places the sponsor purchase before the row-writing game action', () => {
		const game = Action.from({
			account: 'rngfront.gm',
			name: 'joinworld',
			authorization: [{ actor: requester, permission: 'active' }],
			data: '00'
		});
		const purchase = Action.from({
			account: 'eosio',
			name: 'buyrambytes',
			authorization: [{ actor: 'rngfront.gm', permission: 'ram' }],
			data: '00'
		});
		const original = Transaction.from({
			expiration: '2026-09-24T14:00:00',
			ref_block_num: 1,
			ref_block_prefix: 1,
			actions: [game]
		});
		const prepaid = withPrepaidRam(original, purchase);
		expect(prepaid.actions.map((action) => String(action.name))).toEqual([
			'buyrambytes',
			'joinworld'
		]);
		expect(original.actions.map((action) => String(action.name))).toEqual(['joinworld']);
	});
});
