export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Exponential backoff: base, 2x base, 4x base... capped at maxMs.
export function backoffDelayMs(attempt: number, baseMs = 1000, maxMs = 60_000): number {
	return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

export interface RetryOptions {
	baseMs?: number;
	maxMs?: number;
	sleep?: (ms: number) => Promise<void>;
	// Called after each failed attempt, before waiting.
	onFailure?: (error: unknown, attempt: number, delayMs: number) => void | Promise<void>;
}

// Keep calling `fn` until it succeeds, waiting with exponential backoff between attempts.
// It never gives up: a transient error (DNS, RPC timeout) must not leave a service idle.
export async function retryUntilSuccess<T>(
	fn: (attempt: number) => Promise<T>,
	options: RetryOptions = {}
): Promise<T> {
	const wait = options.sleep ?? sleep;
	for (let attempt = 1; ; attempt++) {
		try {
			return await fn(attempt);
		} catch (error) {
			const delay = backoffDelayMs(attempt, options.baseMs, options.maxMs);
			await options.onFailure?.(error, attempt, delay);
			await wait(delay);
		}
	}
}

// Reject if `promise` has not settled within `ms`, so a hung RPC call cannot block a
// protected cron job forever.
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	if (!(ms > 0)) return promise;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Callers that arrive while a run is in progress share it instead of starting another.
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
	let inFlight: Promise<T> | undefined;
	return () => {
		if (!inFlight) {
			inFlight = fn().finally(() => {
				inFlight = undefined;
			});
		}
		return inFlight;
	};
}
