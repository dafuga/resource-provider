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
	getPurchaseAmounts,
	getRamDailyCap,
	getRamMarket,
	getRamPurchaseBytes,
	ramPurchaseAllowed,
	ramWithinDailyCap
} from '$lib/wharf/resources';
import { ANTELOPE_SYSTEM_CONTRACT, MANAGED_ACCOUNT_RAM_MAX_FEE } from 'src/config';

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
			const bytes = getRamPurchaseBytes(managed, data);
			const market = await getRamMarket();
			const cost = estimateRamCost(Number(bytes), market.base, market.quote);
			const dailyCap = getRamDailyCap(managed);
			const spentLastDay = dailyCap > 0 ? await ramPurchases.getSpentLastDay(name) : 0;
			if (!ramPurchaseAllowed(cost)) {
				managerLog.warn('RAM purchase skipped: over MANAGED_ACCOUNT_RAM_MAX_FEE', {
					account: name,
					bytes: Number(bytes),
					estimatedCost: Number.isFinite(cost) ? cost.toFixed(4) : 'n/a',
					maxFee: MANAGED_ACCOUNT_RAM_MAX_FEE
				});
			} else if (!ramWithinDailyCap(spentLastDay, cost, dailyCap)) {
				// The payer funds every RAM top-up; a leaking account must not drain it
				// (pigracing.gm cost ~53 EOS/day on Nov 13).
				await alerts.raise(
					`ram-cap:${name}`,
					`${name}: RAM top-up skipped; ${spentLastDay.toFixed(4)} spent in the last 24h plus ${cost.toFixed(4)} would exceed its ${dailyCap} daily RAM cap`,
					{ account: name, bytes: Number(bytes), spentLastDay, estimatedCost: cost, dailyCap }
				);
			} else {
				const action = await makeBuyRamBytesAction(manager, managed.account, bytes);
				managerLog.debug(
					'buyrambytes action to perform',
					objectify({ account: managed.account, action, bytes })
				);
				actions.push(action);
				ramPurchase = { bytes: Number(bytes), cost };
			}
		}
		if (actions.length) {
			const result = await manager.transact({ actions });
			if (!result.resolved) {
				managerLog.error(
					'account management transaction failed with no result',
					objectify({ managed, result })
				);
				return;
			}
			recordPowerup(name);
			if (ramPurchase) {
				await ramPurchases.recordPurchase(name, ramPurchase.bytes, ramPurchase.cost);
				await alerts.resolve(`ram-cap:${name}`, `${name}: RAM top-ups resumed`);
			}
			managerLog.info(
				'account management transaction successful',
				objectify({
					account: managed.account,
					trx_id: String(result.resolved?.transaction.id)
				})
			);
		} else {
			managerLog.debug(
				'no powerup required',
				objectify({
					account: managed.account
				})
			);
		}
	} catch (error) {
		managerLog.error('manageAccountResources failed', { account, error: String(error) });
	}
}
