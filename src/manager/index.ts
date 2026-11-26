import { API } from '@wharfkit/antelope';
import { Session } from '@wharfkit/session';
import { Cron, type CronOptions } from 'croner';
import { Static } from 'elysia';

import { getManagerContext, type ManagerContext } from './context';
import { manageAccountResources } from './manage/account';
import { fundManagedBalances, fundManagerPayer } from './manage/funding';

import { managed } from '$api/v2/manager';
import { v2ManagedAccountType } from '$api/v2/manager/types';
import { type Alerts, alerts as defaultAlerts } from '$lib/alerts';
import { checkAccountHealth, checkSelfManagementHeartbeat, getAvailableCpuUs } from '$lib/health';
import { getApp, startApp } from '$lib/http';
import { managerLog } from '$lib/logger';
import { objectify } from '$lib/utils';
import { getClient } from '$lib/wharf/client';
import { getPowerupOrders, type PowerupOrder } from '$lib/wharf/leases';
import { getManagerSession } from '$lib/wharf/session';
import {
	ENABLE_RESOURCE_MANAGER,
	MANAGER_CRONJOB,
	MANAGER_MIN_MS,
	MANAGER_PAYER_RESERVE_MS
} from 'src/config';
import { getSelfManagementStatus, runSelfManagementCheck } from 'src/self-management';

const cron = MANAGER_CRONJOB;
const cronOptions: CronOptions = { catch: (e) => managerLog.error(e), protect: true };

export interface ManagerCycleDeps {
	getSession: () => Promise<Session>;
	getContext: () => Promise<ManagerContext>;
	getAccount: (account: string) => Promise<API.v1.AccountObject>;
	fundPayer?: (payer: API.v1.AccountObject, alerts: Alerts) => Promise<void>;
	// Keeps the liquid EOS of accounts that pay for players (RAM payers) above their floor.
	fundBalances?: (alerts: Alerts) => Promise<void>;
	getOrders: (account: string) => Promise<PowerupOrder[]>;
	manageAccount: (
		manager: Session,
		account: Static<typeof v2ManagedAccountType>,
		context: ManagerContext
	) => Promise<void>;
	// Runs the payer's own self-management check; absent when self-management is disabled.
	rescuePayer?: () => Promise<void>;
	selfStatus?: () => { enabled: boolean; startedAt: number; lastCompletedAt?: number };
	payerMinCpuUs?: number;
	payerReserveUs?: number;
	alerts?: Alerts;
}

// The payer pays the CPU of every powerup it sends. Below the reserve it cannot sponsor
// anyone, but its own powerup still lands, so rescue it first. Returns whether the payer
// can cover managed accounts this cycle.
export async function ensurePayerCanPay(
	manager: Session,
	deps: ManagerCycleDeps
): Promise<boolean> {
	const alerts = deps.alerts ?? defaultAlerts;
	const actor = String(manager.actor);
	const reserveUs = deps.payerReserveUs ?? MANAGER_PAYER_RESERVE_MS * 1000;
	try {
		const data = await deps.getAccount(actor);
		const orders = await deps.getOrders(actor).catch(() => {
			managerLog.warn('Payer lease lookup failed', { account: actor });
			return undefined;
		});
		await checkAccountHealth(data, {
			role: 'payer',
			minCpuUs: deps.payerMinCpuUs ?? MANAGER_MIN_MS * 1000,
			orders,
			alerts
		});
		await deps.fundPayer?.(data, alerts).catch(() =>
			alerts.raise(`payer-funding:${actor}`, `payer ${actor}: automatic top-up check failed`, {
				account: actor
			})
		);
		const status = deps.selfStatus?.();
		if (status?.enabled) {
			await checkSelfManagementHeartbeat(status.lastCompletedAt, status.startedAt, { alerts });
		}

		const available = getAvailableCpuUs(data);
		const dryKey = `payer-dry:${actor}`;
		if (available >= reserveUs) {
			await alerts.resolve(dryKey, `payer ${actor} can pay for managed accounts again`);
			return true;
		}
		await alerts.raise(
			dryKey,
			`payer ${actor} has ${available} us CPU, below the ${reserveUs} us reserve needed to pay for managed accounts`,
			{ account: actor, availableUs: available, reserveUs }
		);
		if (!deps.rescuePayer) {
			return false;
		}
		await deps
			.rescuePayer()
			.catch((error) => managerLog.error('Payer rescue failed', { error: String(error) }));
		return getAvailableCpuUs(await deps.getAccount(actor)) >= reserveUs;
	} catch (error) {
		// Unknown payer state should not stop the managed accounts from being tried.
		managerLog.error('Payer check failed', { account: actor, error: String(error) });
		return true;
	}
}

export async function runManagerCycle(deps: ManagerCycleDeps) {
	const manager = await deps.getSession();
	const payerCanPay = await ensurePayerCanPay(manager, deps);
	const managerContext = await deps.getContext();
	if (!payerCanPay) {
		managerLog.error(
			`Payer ${manager.actor} is out of CPU; skipping ${managerContext.managedAccounts.length} managed account(s) until it recovers`
		);
		return;
	}
	const alerts = deps.alerts ?? defaultAlerts;
	await deps.fundBalances?.(alerts).catch((error) => {
		managerLog.error('Managed balance top-up failed', { error: String(error) });
		return alerts.raise('balance-funding:config', 'managed balance top-up check failed', {
			error: String(error)
		});
	});
	for (const account of managerContext.managedAccounts) {
		managerLog.debug('Running resource management', objectify({ account }));
		deps.manageAccount(manager, account, managerContext);
	}
}

const defaultCycleDeps: ManagerCycleDeps = {
	getSession: getManagerSession,
	getContext: getManagerContext,
	getAccount: (account) => getClient().v1.chain.get_account(account),
	getOrders: getPowerupOrders,
	fundPayer: fundManagerPayer,
	fundBalances: fundManagedBalances,
	manageAccount: manageAccountResources,
	rescuePayer: () =>
		getSelfManagementStatus().enabled ? runSelfManagementCheck() : Promise.resolve(),
	selfStatus: getSelfManagementStatus
};

export const managerJob = async function () {
	try {
		await runManagerCycle(defaultCycleDeps);
	} catch (error) {
		managerLog.error('managerJob failed', { error: String(error) });
	}
};

export async function manager() {
	if (!ENABLE_RESOURCE_MANAGER) {
		managerLog.info(
			'Resource Manager Service is disabled. Set ENABLE_RESOURCE_MANAGER=true if you wish to run this service.'
		);
		return;
	}

	const app = getApp();
	app.group('/v2', (root) =>
		root.group('/resource', (resource) => resource.group('/manager', (g) => g.use(managed)))
	);

	startApp();
	managerLog.info('Resource Manager API routes loaded');

	managerLog.info('Resource Manager Service starting', { cron, cronOptions });
	managerJob();
	new Cron(cron, cronOptions, managerJob);
}
