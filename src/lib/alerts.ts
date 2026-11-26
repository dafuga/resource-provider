import { generalLog } from '$lib/logger';
import { ALERT_REPEAT_MINUTES, ALERT_WEBHOOK_URL } from 'src/config';

export type AlertDetails = Record<string, unknown>;

export interface AlertPayload {
	text: string;
	content: string;
	alert: {
		key: string;
		status: 'firing' | 'resolved';
		message: string;
		details: AlertDetails;
		at: string;
	};
}

export type AlertSender = (url: string, payload: AlertPayload) => Promise<void>;

export interface AlertOptions {
	webhookUrl?: string;
	repeatMinutes?: number;
	send?: AlertSender;
	now?: () => number;
}

const WEBHOOK_TIMEOUT_MS = 5000;

// Slack reads `text`, Discord reads `content`; anything else can parse `alert`.
export const postWebhook: AlertSender = async (url, payload) => {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS)
	});
	if (!response.ok) {
		throw new Error(`webhook responded ${response.status}`);
	}
};

// Alerts keyed by condition (e.g. "cpu-low:rsfui4ahy.gm"). A firing alert is logged at error
// level and sent to the webhook, then repeated at most every `repeatMinutes` while it keeps
// firing. Resolving a firing alert logs and sends one "resolved" notice.
export class Alerts {
	private active = new Map<string, { lastSentAt: number }>();

	constructor(private options: AlertOptions = {}) {}

	private get now() {
		return (this.options.now ?? Date.now)();
	}

	isActive(key: string) {
		return this.active.has(key);
	}

	async raise(key: string, message: string, details: AlertDetails = {}): Promise<boolean> {
		const now = this.now;
		const existing = this.active.get(key);
		const repeatMs = (this.options.repeatMinutes ?? ALERT_REPEAT_MINUTES) * 60 * 1000;
		if (existing && now - existing.lastSentAt < repeatMs) {
			return false;
		}
		this.active.set(key, { lastSentAt: now });
		generalLog.error(`ALERT: ${message}`, { alert: key, ...details });
		await this.notify(key, 'firing', message, details, now);
		return true;
	}

	async resolve(key: string, message: string, details: AlertDetails = {}): Promise<boolean> {
		if (!this.active.delete(key)) {
			return false;
		}
		generalLog.info(`RESOLVED: ${message}`, { alert: key, ...details });
		await this.notify(key, 'resolved', message, details, this.now);
		return true;
	}

	reset() {
		this.active.clear();
	}

	private async notify(
		key: string,
		status: 'firing' | 'resolved',
		message: string,
		details: AlertDetails,
		now: number
	) {
		const url = 'webhookUrl' in this.options ? this.options.webhookUrl : ALERT_WEBHOOK_URL;
		if (!url) return;
		const prefix = status === 'firing' ? 'ALERT' : 'RESOLVED';
		const text = `[resource-provider] ${prefix}: ${message}`;
		try {
			await (this.options.send ?? postWebhook)(url, {
				text,
				content: text,
				alert: { key, status, message, details, at: new Date(now).toISOString() }
			});
		} catch (error) {
			// Never let a broken webhook stop resource management.
			generalLog.warn('Alert webhook delivery failed', { alert: key, error: String(error) });
		}
	}
}

export const alerts = new Alerts();
