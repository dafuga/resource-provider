import { afterAll, describe, expect, it } from 'bun:test';

import { configDatabase } from '$lib/db/models/config';
import { policyDatabase } from '$lib/db/models/provider/policy';
import {
	actionMatches,
	invalidatePolicyCache,
	resolveCandidateBuckets,
	resolveFreeGrant,
	ruleMatches,
	validatePattern
} from '$lib/rules';
import type { Policy, PolicyRule } from '$lib/rules';
import { bootstrapPolicy } from '$lib/rules/bootstrap';

const game: PolicyRule = {
	name: 'game',
	bucket: 'shipload',
	allow: ['eon.shipload::*', 'nex.shipload::*'],
	require: []
};
const place: PolicyRule = {
	name: 'place',
	bucket: 'shipload',
	allow: ['eon.shipload::*', 'nex.shipload::*', 'atomicassets::transfer'],
	require: ['eon.shipload::placeentity']
};
const wild: PolicyRule = { name: 'wildcard', bucket: 'wildcard', allow: ['*::*'], require: [] };

const policy: Policy = {
	buckets: [
		{ name: 'shipload', priority: 10, limit_ms: 100, limit_kb: 100, members_only: false },
		{ name: 'wildcard', priority: 1000, limit_ms: 20, limit_kb: 20, members_only: false }
	],
	rules: [game, place, wild]
};

describe('actionMatches', () => {
	it('matches literal, contract-glob, action-glob, and full glob', () => {
		expect(
			actionMatches('eon.shipload::join', { account: 'eon.shipload', name: 'join' })
		).toBeTrue();
		expect(actionMatches('eon.shipload::*', { account: 'eon.shipload', name: 'join' })).toBeTrue();
		expect(actionMatches('*::transfer', { account: 'atomicassets', name: 'transfer' })).toBeTrue();
		expect(actionMatches('*::*', { account: 'anything', name: 'atall' })).toBeTrue();
		expect(actionMatches('eon.shipload::*', { account: 'nex.shipload', name: 'join' })).toBeFalse();
	});
});

describe('validatePattern', () => {
	it('accepts valid patterns and rejects malformed', () => {
		expect(() => validatePattern('eon.shipload::*')).not.toThrow();
		expect(() => validatePattern('*::*')).not.toThrow();
		expect(() => validatePattern('nocolon')).toThrow();
		expect(() => validatePattern('a::b::c')).toThrow();
		expect(() => validatePattern('BadName::x')).toThrow();
	});
});

describe('ruleMatches', () => {
	it('matches a pure-game transaction against game', () => {
		const actions = [
			{ account: 'nex.shipload', name: 'foundcompany' },
			{ account: 'eon.shipload', name: 'join' }
		];
		expect(ruleMatches(game, actions)).toBeTrue();
	});
	it('requires the required pattern to be present', () => {
		const withPlace = [
			{ account: 'atomicassets', name: 'transfer' },
			{ account: 'eon.shipload', name: 'placeentity' }
		];
		const withoutPlace = [{ account: 'atomicassets', name: 'transfer' }];
		expect(ruleMatches(place, withPlace)).toBeTrue();
		expect(ruleMatches(place, withoutPlace)).toBeFalse();
	});
	it('fails coverage when an action is not allowed', () => {
		const actions = [{ account: 'other.game', name: 'doit' }];
		expect(ruleMatches(game, actions)).toBeFalse();
	});
	it('a rule with no patterns never matches a non-empty list', () => {
		const empty: PolicyRule = { name: 'empty', bucket: 'x', allow: [], require: [] };
		expect(ruleMatches(empty, [{ account: 'a', name: 'b' }])).toBeFalse();
	});
});

describe('resolveCandidateBuckets', () => {
	it('dedups and sorts matched buckets by priority', () => {
		const actions = [{ account: 'eon.shipload', name: 'join' }];
		const buckets = resolveCandidateBuckets(policy, actions).map((b) => b.name);
		expect(buckets).toEqual(['shipload', 'wildcard']);
	});
	it('returns empty when nothing matches and no wildcard', () => {
		const noWild: Policy = { buckets: policy.buckets, rules: [game, place] };
		expect(resolveCandidateBuckets(noWild, [{ account: 'other', name: 'x' }])).toHaveLength(0);
	});
});

describe('resolveFreeGrant', () => {
	const needs = { cpu: 10, net: 10 };
	const actions = [{ account: 'eon.shipload', name: 'join' }];
	it('places a single account in the highest-priority bucket', () => {
		const grant = resolveFreeGrant(policy, actions, needs, ['alice'], () => ({ cpu: 0, net: 0 }));
		expect(grant).toEqual([{ account: 'alice', bucket: 'shipload' }]);
	});
	it('spills an exhausted account to the wildcard bucket', () => {
		const usage = (account: string, bucket: string) =>
			bucket === 'shipload' ? { cpu: 100_000, net: 100_000 } : { cpu: 0, net: 0 };
		const grant = resolveFreeGrant(policy, actions, needs, ['bob'], usage);
		expect(grant).toEqual([{ account: 'bob', bucket: 'wildcard' }]);
	});
	it('skips a members-only bucket for non-members', () => {
		const restricted: Policy = {
			...policy,
			buckets: policy.buckets.map((bucket) =>
				bucket.name === 'shipload' ? { ...bucket, members_only: true } : bucket
			)
		};
		const usage = () => ({ cpu: 0, net: 0 });
		expect(resolveFreeGrant(restricted, actions, needs, ['alice'], usage)).toEqual([
			{ account: 'alice', bucket: 'wildcard' }
		]);
		expect(resolveFreeGrant(restricted, actions, needs, ['alice'], usage, () => true)).toEqual([
			{ account: 'alice', bucket: 'shipload' }
		]);
	});
	it('lets different authorizers land in different buckets', () => {
		const usage = (account: string, bucket: string) =>
			account === 'bob' && bucket === 'shipload'
				? { cpu: 100_000, net: 100_000 }
				: { cpu: 0, net: 0 };
		const grant = resolveFreeGrant(policy, actions, needs, ['alice', 'bob'], usage);
		expect(grant).toEqual([
			{ account: 'alice', bucket: 'shipload' },
			{ account: 'bob', bucket: 'wildcard' }
		]);
	});
	it('denies the whole transaction when one account cannot place', () => {
		const usage = (account: string) =>
			account === 'bob' ? { cpu: 999_999, net: 999_999 } : { cpu: 0, net: 0 };
		const grant = resolveFreeGrant(policy, actions, needs, ['alice', 'bob'], usage);
		expect(grant).toBeNull();
	});
	it('returns null when there are no candidate buckets', () => {
		const noWild: Policy = { buckets: policy.buckets, rules: [game, place] };
		const grant = resolveFreeGrant(noWild, [{ account: 'x', name: 'y' }], needs, ['alice'], () => ({
			cpu: 0,
			net: 0
		}));
		expect(grant).toBeNull();
	});
});

function clearAllBuckets() {
	for (const r of policyDatabase.listRules()) {
		policyDatabase.removeRule(r.name);
	}
	for (const b of policyDatabase.listBuckets()) {
		policyDatabase.removeBucket(b.name);
	}
}

describe('bootstrapPolicy', () => {
	afterAll(() => {
		clearAllBuckets();
		policyDatabase.putBucket('wildcard', 1000, 5, 10);
		policyDatabase.putRule('wildcard', 'wildcard');
		policyDatabase.addPattern('wildcard', 'allow', '*::*');
		invalidatePolicyCache();
	});

	it('seeds a wildcard bucket from retired settings when no buckets exist', () => {
		clearAllBuckets();
		configDatabase.set('provider.free_transactions.limit_ms', '7');
		configDatabase.set('provider.free_transactions.limit_kb', '11');
		invalidatePolicyCache();
		bootstrapPolicy();
		expect(policyDatabase.getBucket('wildcard')).toEqual({
			name: 'wildcard',
			priority: 1000,
			limit_ms: 7,
			limit_kb: 11,
			members_only: false
		});
		expect(policyDatabase.listPatterns('wildcard')).toContainEqual({
			rule: 'wildcard',
			kind: 'allow',
			pattern: '*::*'
		});
	});
	it('is a no-op when buckets already exist', () => {
		clearAllBuckets();
		policyDatabase.putBucket('existing', 1, 1, 1);
		bootstrapPolicy();
		expect(policyDatabase.getBucket('wildcard')).toBeUndefined();
	});
});
