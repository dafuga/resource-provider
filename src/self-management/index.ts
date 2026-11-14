import { PrivateKey } from '@wharfkit/antelope';
import { Cron, type CronOptions } from 'croner';

import { type Alerts, alerts as defaultAlerts } from '$lib/alerts';
import { generalLog } from '$lib/logger';
import { retryUntilSuccess, singleFlight, withTimeout } from '$lib/retry';
import { manageSelfResources, type SelfManagementConfig } from '$lib/self-management';
import { getClient } from '$lib/wharf/client';
import { getManagerSession } from '$lib/wharf/session';
import {
	ENABLE_SELF_MANAGEMENT,
	MANAGER_ACCOUNT_NAME,
	MANAGER_BUYRAM_ENABLED,
	MANAGER_INC_KB,
	MANAGER_INC_MS,
	MANAGER_MAX_FEE,
	MANAGER_MIN_KB,
	MANAGER_MIN_MS,
	MANAGER_RAM_MINIMUM_KB,
	MANAGER_SELF_CHECK_TIMEOUT_SECONDS,
	MANAGER_SELF_CRONJOB,
	MANAGER_SELF_RETRY_MAX_SECONDS
} from 'src/config';

const cronOptions: CronOptions = {
	catch: (e) => generalLog.error('Self-management cron failed', { error: String(e) }),
	protect: true
};

const selfConfig: SelfManagementConfig = {
	minMs: MANAGER_MIN_MS,
	minKb: MANAGER_MIN_KB,
	incMs: MANAGER_INC_MS,
	incKb: MANAGER_INC_KB,
	maxFee: MANAGER_MAX_FEE,
	buyramEnabled: MANAGER_BUYRAM_ENABLED,
	ramMinimumKb: MANAGER_RAM_MINIMUM_KB
};

const startedAt = Date.now();
let lastCompletedAt: number | undefined;

// Used by the manager job's heartbeat alert.
export function getSelfManagementStatus() {
	return { enabled: ENABLE_SELF_MANAGEMENT, startedAt, lastCompletedAt };
}

async function selfManagementCheck() {
	const session = await getManagerSession();
	// A hung RPC call must not block the protected cron forever.
	await withTimeout(
		manageSelfResources(session, selfConfig),
		MANAGER_SELF_CHECK_TIMEOUT_SECONDS * 1000,
		'Self-management check'
	);
	lastCompletedAt = Date.now();
}

// One check at a time: the startup run, the cron and a payer rescue from the manager job
// share a run instead of each buying a powerup (two identical orders at startup on Nov 14).
export const runSelfManagementCheck = singleFlight(selfManagementCheck);

// The account itself is misconfigured (not a network problem); "manager setup" fixes it.
export class AccountConfigurationError extends Error {}

export async function verifyAccountPermission(): Promise<void> {
	const session = await getManagerSession();
	const publicKey = PrivateKey.from(session.walletPlugin.data.privateKey).toPublic();
	const accountData = await getClient().v1.chain.get_account(session.actor);
	const permission = accountData.permissions.find((p) => p.perm_name.equals(session.permission));
	if (!permission) {
		throw new AccountConfigurationError(
			`permission "${session.permission}" not found on account "${session.actor}". Run "manager setup" to configure the account.`
		);
	}
	if (!permission.required_auth.keys.some((k) => k.key.equals(publicKey))) {
		throw new AccountConfigurationError(
			`key ${publicKey} is not authorized on "${session.actor}@${session.permission}". Run "manager setup" to configure the account.`
		);
	}
}

export interface SelfManagementDeps {
	verify: () => Promise<void>;
	run: () => Promise<void>;
	schedule: (job: () => Promise<void>) => void;
	sleep?: (ms: number) => Promise<void>;
	maxRetrySeconds?: number;
	alerts?: Alerts;
}

// Verify the account, retrying with backoff until it succeeds, then schedule and run the
// checks. Before, a single failed startup check (DNS timeout after an OS auto-update restart,
// Nov 14 06:16 UTC) returned without ever scheduling the cron, leaving the payer unmanaged.
export async function startSelfManagement(deps: SelfManagementDeps) {
	const alerts = deps.alerts ?? defaultAlerts;
	await retryUntilSuccess(deps.verify, {
		maxMs: (deps.maxRetrySeconds ?? MANAGER_SELF_RETRY_MAX_SECONDS) * 1000,
		sleep: deps.sleep,
		onFailure: async (error, attempt, delayMs) => {
			const message = `Self-Management: unable to verify account "${MANAGER_ACCOUNT_NAME}" (attempt ${attempt}): ${String(error)}; retrying in ${Math.round(delayMs / 1000)}s`;
			// Configuration errors and repeated failures alert; the first blips are only warnings.
			if (error instanceof AccountConfigurationError || attempt >= 3) {
				await alerts.raise('self-verify', message, { attempt });
			} else {
				generalLog.warn(message);
			}
		}
	});
	await alerts.resolve('self-verify', 'Self-Management: account verified');
	generalLog.info('Self-Management Service starting', { cron: MANAGER_SELF_CRONJOB });
	deps.schedule(deps.run);
	await deps
		.run()
		.catch((error) => generalLog.error('Self-management check failed', { error: String(error) }));
}

export async function selfManagement() {
	if (!ENABLE_SELF_MANAGEMENT) {
		generalLog.info(
			'Self-Management Service is disabled. Set ENABLE_SELF_MANAGEMENT=true if you wish to run this service.'
		);
		return;
	}

	if (!MANAGER_ACCOUNT_NAME) {
		generalLog.error('Self-Management requires MANAGER_ACCOUNT_NAME to be configured.');
		return;
	}

	await startSelfManagement({
		verify: verifyAccountPermission,
		run: runSelfManagementCheck,
		schedule: (job) => {
			new Cron(MANAGER_SELF_CRONJOB, cronOptions, job);
		}
	});
}
