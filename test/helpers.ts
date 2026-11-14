import { API, Asset, Int64 } from '@wharfkit/antelope';

import { Alerts, type AlertPayload } from '$lib/alerts';

// Minimal get_account response: CPU limit (us) and liquid balance.
export function accountData(
	name: string,
	cpu: { max: number; used: number },
	balance = '1234.1737 EOS'
): API.v1.AccountObject {
	return {
		account_name: name,
		cpu_limit: {
			max: Int64.from(cpu.max),
			used: Int64.from(cpu.used),
			current_used: Int64.from(cpu.used)
		},
		net_limit: { max: Int64.from(1_000_000), used: Int64.zero, current_used: Int64.zero },
		ram_quota: Int64.from(311_749),
		ram_usage: Int64.from(87_721),
		core_liquid_balance: Asset.from(balance)
	} as unknown as API.v1.AccountObject;
}

// Alerts that record webhook payloads instead of sending them.
export function recordingAlerts(now: () => number = Date.now) {
	const sent: AlertPayload[] = [];
	const alerts = new Alerts({
		webhookUrl: 'https://hooks.example.test/rp',
		repeatMinutes: 30,
		now,
		send: async (_url, payload) => {
			sent.push(payload);
		}
	});
	return { alerts, sent };
}
