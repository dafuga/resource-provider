import { Action, Asset, Int64, NameType } from '@wharfkit/antelope';
import { Session } from '@wharfkit/session';

import { ManagedAccount } from '$lib/db/models/manager/account';
import { checkAccountHealth } from '$lib/health';
import { generalLog } from '$lib/logger';
import { getPowerupParams } from '$lib/wharf/actions/powerup';
import { getClient } from '$lib/wharf/client';
import { getContract } from '$lib/wharf/contracts';
import { inPowerupCooldown, recordPowerup } from '$lib/wharf/cooldown';
import { getPowerupOrders, getRequiredResourcesWithRenewals } from '$lib/wharf/leases';
import { getPurchaseAmounts, getResourcesClient, getSampledUsage } from '$lib/wharf/resources';
import {
	ANTELOPE_SYSTEM_CONTRACT,
	ANTELOPE_SYSTEM_TOKEN,
	MANAGER_SELF_RENEW_BEFORE_EXPIRY_MINUTES
} from 'src/config';

export interface SelfManagementConfig {
	minMs: number;
	minKb: number;
	incMs: number;
	incKb: number;
	maxFee: string;
	buyramEnabled: boolean;
	ramMinimumKb: number;
	// Minutes before expiry to renew the payer's own leases (default MANAGER_SELF_RENEW_BEFORE_EXPIRY_MINUTES).
	renewBeforeExpiryMinutes?: number;
}

export function getSelfManagedAccount(actor: NameType, config: SelfManagementConfig) {
	return ManagedAccount.from({
		account: actor,
		min_ms: Int64.from(config.minMs),
		min_kb: Int64.from(config.minKb),
		min_ram_kb: Int64.zero,
		inc_ms: Int64.from(config.incMs),
		inc_kb: Int64.from(config.incKb),
		inc_ram_kb: Int64.zero,
		max_fee: Asset.fromFloat(Number(config.maxFee), ANTELOPE_SYSTEM_TOKEN)
	});
}

export async function manageSelfResources(session: Session, config: SelfManagementConfig) {
	const { actor } = session;
	generalLog.verbose('Self-management check', { account: actor });

	const data = await getClient().v1.chain.get_account(actor);
	const actions: Action[] = [];

	if (config.buyramEnabled) {
		const ramAvailable = data.ram_quota.subtracting(data.ram_usage);
		const ramMinimum = Int64.from(config.ramMinimumKb).multiplying(1000);
		if (ramAvailable.lt(ramMinimum)) {
			const ramDeficit = ramMinimum.subtracting(ramAvailable);
			generalLog.info('Self-management: buying RAM', { account: actor, bytes: ramDeficit });
			const systemContract = await getContract(ANTELOPE_SYSTEM_CONTRACT);
			actions.push(
				await systemContract.action('buyrambytes', {
					payer: actor,
					receiver: actor,
					bytes: ramDeficit
				})
			);
		}
	}

	const managed = getSelfManagedAccount(actor, config);
	const orders = await getPowerupOrders(actor);
	await checkAccountHealth(data, {
		role: 'payer',
		minCpuUs: config.minMs * 1000,
		orders
	});

	if (inPowerupCooldown(String(actor))) {
		generalLog.debug('powerup cooldown active, skipping', { account: String(actor) });
		return;
	}
	// The payer renews its own leases well ahead of expiry: if its CPU runs out it can still
	// rescue itself, but it cannot pay for any other account until it does.
	const requiredResources = await getRequiredResourcesWithRenewals(managed, data, {
		orders,
		windowMinutes: config.renewBeforeExpiryMinutes ?? MANAGER_SELF_RENEW_BEFORE_EXPIRY_MINUTES
	});
	const amounts = getPurchaseAmounts(managed, data, requiredResources);
	const sampleUsage = await getSampledUsage();
	const powerup = await getResourcesClient().v1.powerup.get_state();

	const params = getPowerupParams(
		amounts.ms,
		amounts.kb,
		powerup,
		sampleUsage,
		requiredResources,
		actor,
		actor,
		managed.max_fee
	);

	if (params.cpu_frac.gt(Int64.zero) || params.net_frac.gt(Int64.zero)) {
		generalLog.info('Self-management: powering up', { account: actor });
		const systemContract = await getContract(ANTELOPE_SYSTEM_CONTRACT);
		actions.push(await systemContract.action('powerup', params));
	} else {
		generalLog.verbose('Self-management: no powerup required', { account: actor });
	}

	if (actions.length) {
		const result = await session.transact({ actions }).catch((error) => {
			generalLog.error('Self-management transaction failed: ' + String(error));
		});
		if (!result) {
			generalLog.error('Self-management transaction failed with no result', {
				account: actor
			});
			return;
		}
		if (params.cpu_frac.gt(Int64.zero) || params.net_frac.gt(Int64.zero))
			recordPowerup(String(actor));
		generalLog.info('Self-management transaction successful', {
			account: actor,
			trx_id: String(result.resolved?.transaction.id)
		});
	}
}
