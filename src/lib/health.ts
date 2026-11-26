import { API } from '@wharfkit/antelope';

import { Alerts, alerts as defaultAlerts } from '$lib/alerts';
import { getLeaseRenewals, PowerupOrder } from '$lib/wharf/leases';
import {
	ALERT_CPU_GRACE_SECONDS,
	ALERT_LEASE_EXPIRY_MINUTES,
	ALERT_PAYER_MIN_BALANCE,
	ALERT_SELF_STALE_MINUTES
} from 'src/config';

export interface AccountHealthOptions {
	role: 'payer' | 'managed';
	// The account's CPU minimum in microseconds (min_ms * 1000).
	minCpuUs: number;
	// The account's powerup orders, for the lease-expiry check.
	orders?: PowerupOrder[];
	now?: number;
	alerts?: Alerts;
	cpuGraceSeconds?: number;
	leaseExpiryMinutes?: number;
	// Payer only: alert when the liquid balance falls below this.
	minBalance?: number;
}

// When each account first went below its CPU minimum (cleared once it recovers).
const belowMinimumSince = new Map<string, number>();

export function resetHealthState() {
	belowMinimumSince.clear();
}

export function getAvailableCpuUs(data: API.v1.AccountObject): number {
	return Number(data.cpu_limit.max) - Number(data.cpu_limit.current_used ?? data.cpu_limit.used);
}

// Raise alerts before an account (or the payer) runs out:
// - lease-expiring: the lease carrying most of its CPU/NET expires soon and was not renewed
//   (renewal normally happens hours earlier, so this means renewal is failing);
// - cpu-low: it has stayed below its CPU minimum for longer than the grace period
//   (the manager tops up within seconds, so this means top-ups are failing);
// - payer-balance: the payer's liquid balance is below ALERT_PAYER_MIN_BALANCE.
export async function checkAccountHealth(
	data: API.v1.AccountObject,
	options: AccountHealthOptions
) {
	const account = String(data.account_name);
	const now = options.now ?? Date.now();
	const alerts = options.alerts ?? defaultAlerts;
	const who = options.role === 'payer' ? `payer ${account}` : account;

	if (options.orders) {
		const leaseMinutes = options.leaseExpiryMinutes ?? ALERT_LEASE_EXPIRY_MINUTES;
		const lease = getLeaseRenewals(options.orders, now, leaseMinutes);
		const leaseKey = `lease-expiring:${account}`;
		if (lease.cpuRequired || lease.netRequired) {
			const kinds = [lease.cpuRequired && 'CPU', lease.netRequired && 'NET'].filter(Boolean);
			await alerts.raise(
				leaseKey,
				`${who}: ${kinds.join('/')} lease expires within ${leaseMinutes} min and has not been renewed`,
				{ account, role: options.role, cpu: lease.cpuRequired, net: lease.netRequired }
			);
		} else {
			await alerts.resolve(leaseKey, `${who}: leases renewed`, { account });
		}
	}

	const graceSeconds = options.cpuGraceSeconds ?? ALERT_CPU_GRACE_SECONDS;
	const available = getAvailableCpuUs(data);
	const cpuKey = `cpu-low:${account}`;
	if (available < options.minCpuUs) {
		const since = belowMinimumSince.get(account) ?? now;
		belowMinimumSince.set(account, since);
		if (graceSeconds > 0 && now - since >= graceSeconds * 1000) {
			await alerts.raise(
				cpuKey,
				`${who}: only ${available} us CPU available (minimum ${options.minCpuUs} us) for ${Math.round((now - since) / 1000)}s`,
				{ account, role: options.role, availableUs: available, minimumUs: options.minCpuUs }
			);
		}
	} else {
		belowMinimumSince.delete(account);
		await alerts.resolve(cpuKey, `${who}: CPU back above minimum`, {
			account,
			availableUs: available
		});
	}

	if (options.role === 'payer') {
		const minBalance = options.minBalance ?? ALERT_PAYER_MIN_BALANCE;
		const balance = data.core_liquid_balance ? data.core_liquid_balance.value : 0;
		const balanceKey = `payer-balance:${account}`;
		if (minBalance > 0 && balance < minBalance) {
			await alerts.raise(
				balanceKey,
				`${who}: balance ${balance} is below ${minBalance}; it pays every powerup and RAM top-up`,
				{ account, balance, minimum: minBalance }
			);
		} else {
			await alerts.resolve(balanceKey, `${who}: balance back above minimum`, { account, balance });
		}
	}
}

// Alert when self-management has stopped completing checks (e.g. a startup check that
// never succeeded, or a hung call), so the payer is no longer being looked after.
export async function checkSelfManagementHeartbeat(
	lastCompletedAt: number | undefined,
	startedAt: number,
	options: { now?: number; staleMinutes?: number; alerts?: Alerts } = {}
) {
	const now = options.now ?? Date.now();
	const staleMinutes = options.staleMinutes ?? ALERT_SELF_STALE_MINUTES;
	const alerts = options.alerts ?? defaultAlerts;
	if (!(staleMinutes > 0)) return;
	const last = lastCompletedAt ?? startedAt;
	const ageMinutes = (now - last) / 60_000;
	if (ageMinutes >= staleMinutes) {
		await alerts.raise(
			'self-stale',
			`self-management has not completed a check for ${Math.floor(ageMinutes)} min; the payer is not being looked after`,
			{ lastCompletedAt: lastCompletedAt ? new Date(lastCompletedAt).toISOString() : null }
		);
	} else {
		await alerts.resolve('self-stale', 'self-management is completing checks again');
	}
}
