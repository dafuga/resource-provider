import { API, Int64 } from '@wharfkit/antelope';
import { Resources } from '@wharfkit/resources';

import { AccountRequiredResources } from './actions/powerup';
import { getClient } from './client';

import { ManagedAccount } from '$lib/db/models/manager/account';
import { generalLog, managerLog } from '$lib/logger';
import { AccountResources } from '$lib/types';
import { objectify } from '$lib/utils';
import {
	ANTELOPE_SAMPLE_ACCOUNT,
	ENABLE_MANAGED_ACCOUNT_RAM,
	MANAGED_ACCOUNT_RAM_DAILY_MAX_FEE,
	MANAGED_ACCOUNT_RAM_MAX_FEE
} from 'src/config';

export function getResourcesClient() {
	return new Resources({
		api: getClient(),
		sampleAccount: ANTELOPE_SAMPLE_ACCOUNT
	});
}

export async function getSampledUsage() {
	const usage = await getResourcesClient().getSampledUsage();
	generalLog.silly('Sampled Usage', objectify(usage));
	return usage;
}

export function getAccountCurrentResources(data: API.v1.AccountObject): AccountResources {
	const resources = {
		cpu: data.cpu_limit.max.subtracting(data.cpu_limit.current_used),
		net: data.net_limit.max.subtracting(data.net_limit.current_used),
		ram: data.ram_quota.subtracting(data.ram_usage)
	};
	generalLog.debug('Current Account Resources', {
		account: String(data.account_name),
		cpu: Number(resources.cpu),
		net: Number(resources.net),
		ram: Number(resources.ram)
	});
	return resources;
}

export function getAccountRequiresCPU(
	account: ManagedAccount,
	resources: AccountResources
): boolean {
	const cpuMinimum = account.min_ms.multiplying(1000);
	const cpuRequired = resources.cpu.lt(cpuMinimum);
	managerLog.debug(
		'Account CPU Resource Status',
		objectify({ cpuMinimum, cpuCurrent: resources.cpu, cpuRequired })
	);
	return cpuRequired;
}

export function getAccountRequiresNET(
	account: ManagedAccount,
	resources: AccountResources
): boolean {
	const netMinimum = account.min_kb.multiplying(1000);
	const netRequired = resources.net.lt(netMinimum);
	managerLog.debug(
		'Account NET Resource Status',
		objectify({ netMinimum, netCurrent: resources.net, netRequired })
	);
	return netRequired;
}

export function getAccountRequiresRAM(
	account: ManagedAccount,
	resources: AccountResources,
	enabled = ENABLE_MANAGED_ACCOUNT_RAM
): boolean {
	if (!enabled) {
		return false;
	}
	if (account.min_ram_kb.lte(Int64.zero) || account.inc_ram_kb.lte(Int64.zero)) {
		return false;
	}
	const ramMinimum = account.min_ram_kb.multiplying(1000);
	const ramRequired = resources.ram.lt(ramMinimum);
	managerLog.debug(
		'Account RAM Resource Status',
		objectify({ ramMinimum, ramCurrent: resources.ram, ramRequired })
	);
	return ramRequired;
}

export function getAccountRequiredResources(
	managed: ManagedAccount,
	data: API.v1.AccountObject
): AccountRequiredResources {
	const resources = getAccountCurrentResources(data);
	const cpuRequired = getAccountRequiresCPU(managed, resources);
	const netRequired = getAccountRequiresNET(managed, resources);
	const ramRequired = getAccountRequiresRAM(managed, resources);
	if (cpuRequired || netRequired || ramRequired) {
		managerLog.info(
			'Account requires additional resources',
			objectify({
				account: managed.account,
				cpu: {
					current: resources.cpu,
					minimum: managed.min_ms.multiplying(1000),
					required: cpuRequired
				},
				net: {
					current: resources.net,
					minimum: managed.min_kb.multiplying(1000),
					required: netRequired
				},
				ram: {
					current: resources.ram,
					minimum: managed.min_ram_kb.multiplying(1000),
					required: ramRequired
				}
			})
		);
	}
	return { cpuRequired, netRequired, ramRequired };
}

// Size a purchase so one powerup clears the whole deficit: the configured increment plus
// whatever is missing to get back above the minimum. Buying only the fixed increment
// left accounts deep below zero re-buying every cycle (rngfront.gm, Nov 1).
export function getPurchaseAmounts(
	managed: ManagedAccount,
	data: API.v1.AccountObject,
	required: AccountRequiredResources
): { ms: Int64; kb: Int64 } {
	const resources = getAccountCurrentResources(data);
	const deficit = (current: Int64, minimumUnits: Int64) => {
		const missing = Number(minimumUnits) - Number(current);
		return missing > 0 ? Math.ceil(missing / 1000) : 0;
	};
	const ms = required.cpuRequired
		? Number(managed.inc_ms) + deficit(resources.cpu, managed.min_ms.multiplying(1000))
		: Number(managed.inc_ms);
	const kb = required.netRequired
		? Number(managed.inc_kb) + deficit(resources.net, managed.min_kb.multiplying(1000))
		: Number(managed.inc_kb);
	return { ms: Int64.from(ms), kb: Int64.from(kb) };
}

// RAM to buy for a managed account: the configured increment plus whatever is missing
// to get back above its minimum.
export function getRamPurchaseBytes(managed: ManagedAccount, data: API.v1.AccountObject): Int64 {
	const free = Number(data.ram_quota.subtracting(data.ram_usage));
	const missing = Math.max(0, Number(managed.min_ram_kb) * 1000 - free);
	return Int64.from(Number(managed.inc_ram_kb) * 1000 + missing);
}

// Bancor estimate of the cost of buying `bytes` from the RAM market, plus the 0.5% fee.
export function estimateRamCost(bytes: number, base: number, quote: number): number {
	if (bytes <= 0) return 0;
	if (bytes >= base) return Infinity;
	return ((quote * bytes) / (base - bytes)) * 1.005;
}

export async function getRamMarket(): Promise<{ base: number; quote: number }> {
	const result = (await getClient().v1.chain.get_table_rows({
		code: 'eosio',
		scope: 'eosio',
		table: 'rammarket',
		json: true
	})) as API.v1.GetTableRowsResponse;
	const row = result.rows[0] as {
		base: { balance: string };
		quote: { balance: string };
	};
	return {
		base: parseFloat(String(row.base.balance)),
		quote: parseFloat(String(row.quote.balance))
	};
}

export function ramPurchaseAllowed(cost: number, maxFee = MANAGED_ACCOUNT_RAM_MAX_FEE): boolean {
	return Number.isFinite(cost) && cost <= maxFee;
}

// The account's own rolling-24h RAM spend cap, or the default when it has none. 0 = no cap.
export function getRamDailyCap(
	managed: ManagedAccount,
	fallback = MANAGED_ACCOUNT_RAM_DAILY_MAX_FEE
): number {
	const own = Number(managed.ram_daily_max_fee ?? 0);
	return own > 0 ? own : fallback;
}

export function ramWithinDailyCap(spentLastDay: number, cost: number, cap: number): boolean {
	return !(cap > 0) || spentLastDay + cost <= cap;
}
