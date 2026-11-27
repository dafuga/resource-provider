import { Action, Int64 } from '@wharfkit/antelope';
import { Session } from '@wharfkit/session';
import { Static } from 'elysia';

import { ManagerContext } from '../context';

import { v2ManagedAccountType } from '$api/v2/manager/types';
import { alerts } from '$lib/alerts';
import { ManagedAccount } from '$lib/db/models/manager/account';
import { ramPurchases } from '$lib/db/models/manager/ram-purchases';
import { checkAccountHealth } from '$lib/health';
import { managerLog } from '$lib/logger';
import { makeBuyRamBytesAction } from '$lib/manager/setup';
import { objectify } from '$lib/utils';
import { getPowerupParams } from '$lib/wharf/actions/powerup';
import { getClient } from '$lib/wharf/client';
import { getContract } from '$lib/wharf/contracts';
import { inPowerupCooldown, recordPowerup } from '$lib/wharf/cooldown';
import { getPowerupOrders, getRequiredResourcesWithRenewals } from '$lib/wharf/leases';
import {
	estimateRamCost,
	fitRamPurchase,
	getPurchaseAmounts,
	getRamDailyCap,
	getRamMarket,
	getRamPurchaseBytes,
	ramWithinDailyCap
} from '$lib/wharf/resources';
import {
	ALERT_MANAGE_FAILURES,
	ANTELOPE_SYSTEM_CONTRACT,
	MANAGED_ACCOUNT_RAM_MAX_FEE
} from 'src/config';

const failures = new Map<string, number>();

// One failed cycle is often a busy RPC; several in a row means the account is not being
// kept resourced, so alert on that instead of on every miss.
async function recordOutcome(name: string, ok: boolean, error?: string) {
	const key = `manage-failed:${name}`;
	if (ok) {
		if (failures.has(name)) {
			failures.delete(name);
			await alerts.resolve(key, `${name}: resource top-ups working again`, { account: name });
		}
		return;
	}
	const count = (failures.get(name) ?? 0) + 1;
	failures.set(name, count);
	if (count >= ALERT_MANAGE_FAILURES) {
		await alerts.raise(key, `${name}: ${count} resource top-up attempts in a row failed`, {
			account: name,
			failures: count,
			error
		});
	}
}

export function resetManageFailures() {
	failures.clear();
}

export async function manageAccountResources(
	manager: Session,
	account: Static<typeof v2ManagedAccountType>,
	context: ManagerContext
) {
	try {
		const managed = ManagedAccount.from({
			min_ram_kb: 0,
			inc_ram_kb: 0,
			...account
		});
		const name = String(managed.account);
		const data = await getClient().v1.chain.get_account(managed.account);
		const orders = await getPowerupOrders(managed.account);
		await checkAccountHealth(data, {
			role: 'managed',
			minCpuUs: Number(managed.min_ms) * 1000,
			orders
		});
		if (inPowerupCooldown(name)) {
			managerLog.debug('powerup cooldown active, skipping', { account: name });
			return;
		}
		const requiredResources = await getRequiredResourcesWithRenewals(managed, data, { orders });
		const amounts = getPurchaseAmounts(managed, data, requiredResources);
		const actions: Action[] = [];
		let ramPurchase: { bytes: number; cost: number } | undefined;
		const params = getPowerupParams(
			amounts.ms,
			amounts.kb,
			context.powerup,
			context.sampleUsage,
			requiredResources,
			manager.actor,
			managed.account,
			managed.max_fee
		);
		if (params.cpu_frac.gt(Int64.zero) || params.net_frac.gt(Int64.zero)) {
			const systemContract = await getContract(ANTELOPE_SYSTEM_CONTRACT);
			const action = await systemContract.action('powerup', params);
			managerLog.debug(
				'powerup action to perform',
				objectify({ account: managed.account, action, params })
			);
			actions.push(action);
		}
		if (requiredResources.ramRequired) {
			const wanted = Number(getRamPurchaseBytes(managed, data));
			const market = await getRamMarket();
			const { bytes, cost } = fitRamPurchase(wanted, market.base, market.quote);
			const dailyCap = getRamDailyCap(managed);
			const spentLastDay = dailyCap > 0 ? await ramPurchases.getSpentLastDay(name) : 0;
			if (bytes <= 0) {
				const estimatedCost = estimateRamCost(wanted, market.base, market.quote);
				await alerts.raise(
					`ram-max-fee:${name}`,
					`${name}: RAM top-up skipped; no part of ${wanted} bytes can be bought within MANAGED_ACCOUNT_RAM_MAX_FEE ${MANAGED_ACCOUNT_RAM_MAX_FEE}`,
					{ account: name, bytes: wanted, estimatedCost, maxFee: MANAGED_ACCOUNT_RAM_MAX_FEE }
				);
			} else if (!ramWithinDailyCap(spentLastDay, cost, dailyCap)) {
				// The payer funds every RAM top-up; a leaking account must not drain it
				// (pigracing.gm cost ~53 EOS/day on Nov 13).
				await alerts.raise(
					`ram-cap:${name}`,
					`${name}: RAM top-up skipped; ${spentLastDay.toFixed(4)} spent in the last 24h plus ${cost.toFixed(4)} would exceed its ${dailyCap} daily RAM cap`,
					{ account: name, bytes, spentLastDay, estimatedCost: cost, dailyCap }
				);
			} else {
				if (bytes < wanted) {
					managerLog.warn(
						'RAM purchase reduced to fit MANAGED_ACCOUNT_RAM_MAX_FEE; later cycles buy the rest',
						{
							account: name,
							bytes,
							wantedBytes: wanted,
							estimatedCost: cost.toFixed(4),
							maxFee: MANAGED_ACCOUNT_RAM_MAX_FEE
						}
					);
				}
				const action = await makeBuyRamBytesAction(manager, managed.account, Int64.from(bytes));
				managerLog.debug(
					'buyrambytes action to perform',
					objectify({ account: managed.account, action, bytes })
				);
				actions.push(action);
				ramPurchase = { bytes, cost };
			}
		} else {
			await alerts.resolve(`ram-max-fee:${name}`, `${name}: RAM back above its minimum`);
		}
		if (actions.length) {
			const result = await manager.transact({ actions });
			if (!result.resolved) {
				managerLog.error(
					'account management transaction failed with no result',
					objectify({ managed, result })
				);
				await recordOutcome(name, false, 'no result');
				return;
			}
			recordPowerup(name);
			await recordOutcome(name, true);
			if (ramPurchase) {
				await ramPurchases.recordPurchase(name, ramPurchase.bytes, ramPurchase.cost);
				await alerts.resolve(`ram-cap:${name}`, `${name}: RAM top-ups resumed`);
				await alerts.resolve(`ram-max-fee:${name}`, `${name}: RAM top-ups resumed`);
			}
			managerLog.info(
				'account management transaction successful',
				objectify({
					account: managed.account,
					trx_id: String(result.resolved?.transaction.id)
				})
			);
		} else {
			await recordOutcome(name, true);
			managerLog.debug(
				'no powerup required',
				objectify({
					account: managed.account
				})
			);
		}
	} catch (error) {
		managerLog.error('manageAccountResources failed', { account, error: String(error) });
		await recordOutcome(String(account.account), false, String(error)).catch(() => undefined);
	}
}
