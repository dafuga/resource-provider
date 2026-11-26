import { and, eq, gt, lt, sql } from 'drizzle-orm';

import { database } from '$lib/db';
import { AbstractDatabase } from '$lib/db/abstract';

const DAY_SECONDS = 24 * 3600;

// Persistent ledger of managed-account RAM purchases. It backs the per-account daily RAM
// cap, so a restart (e.g. an OS auto-update) does not reset an account's spend.
export class RamPurchaseDatabase extends AbstractDatabase {
	async recordPurchase(account: string, bytes: number, cost: number, now = Date.now()) {
		const createdAt = Math.floor(now / 1000);
		database
			.insert(this.schema.ramPurchases)
			.values({ account, bytes, cost, created_at: createdAt })
			.run();
		// Keep two days of history; older rows no longer affect any cap.
		database
			.delete(this.schema.ramPurchases)
			.where(lt(this.schema.ramPurchases.created_at, createdAt - 2 * DAY_SECONDS))
			.run();
	}

	async getSpentLastDay(account: string, now = Date.now()): Promise<number> {
		const since = Math.floor(now / 1000) - DAY_SECONDS;
		const result = database
			.select({ cost: sql<number>`coalesce(sum(${this.schema.ramPurchases.cost}), 0)` })
			.from(this.schema.ramPurchases)
			.where(
				and(
					eq(this.schema.ramPurchases.account, account),
					gt(this.schema.ramPurchases.created_at, since)
				)
			)
			.get();
		return result?.cost ?? 0;
	}

	async reset() {
		database.delete(this.schema.ramPurchases).run();
	}
}

export const ramPurchases = new RamPurchaseDatabase();
