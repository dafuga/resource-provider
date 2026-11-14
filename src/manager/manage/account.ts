import { Action, Int64 } from '@wharfkit/antelope';
import { Session } from '@wharfkit/session';
import { Static } from 'elysia';

import { ManagerContext } from '../context';

import { v2ManagedAccountType } from '$api/v2/manager/types';
import { ManagedAccount } from '$lib/db/models/manager/account';
import { managerLog } from '$lib/logger';
import { makeBuyRamBytesAction } from '$lib/manager/setup';
import { objectify } from '$lib/utils';
import { getPowerupParams } from '$lib/wharf/actions/powerup';
import { getClient } from '$lib/wharf/client';
import { getContract } from '$lib/wharf/contracts';
import { inPowerupCooldown, recordPowerup } from '$lib/wharf/cooldown';
import { getRequiredResourcesWithRenewals } from '$lib/wharf/leases';
import {
	estimateRamCost,
	getPurchaseAmounts,
	getRamMarket,
	getRamPurchaseBytes,
	ramPurchaseAllowed
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
		const data = await getClient().v1.chain.get_account(managed.account);
		if (inPowerupCooldown(String(managed.account))) {
			managerLog.debug('powerup cooldown active, skipping', { account: String(managed.account) });
			return;
		}
		const requiredResources = await getRequiredResourcesWithRenewals(managed, data);
		const amounts = getPurchaseAmounts(managed, data, requiredResources);
		const actions: Action[] = [];
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
			if (!ramPurchaseAllowed(cost)) {
				managerLog.warn('RAM purchase skipped: over MANAGED_ACCOUNT_RAM_MAX_FEE', {
					account: String(managed.account),
					bytes: Number(bytes),
					estimatedCost: Number.isFinite(cost) ? cost.toFixed(4) : 'n/a',
					maxFee: MANAGED_ACCOUNT_RAM_MAX_FEE
				});
			} else {
				const action = await makeBuyRamBytesAction(manager, managed.account, bytes);
				managerLog.debug(
					'buyrambytes action to perform',
					objectify({ account: managed.account, action, bytes })
				);
				actions.push(action);
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
			recordPowerup(String(managed.account));
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
