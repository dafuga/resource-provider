import { and, eq, gt, lt, sql } from 'drizzle-orm';

import { database } from '$lib/db';
import { AbstractDatabase } from '$lib/db/abstract';
import { PROVIDER_USAGE_WINDOW_HOURS } from 'src/config';

export interface AccountUsage {
	account: string;
	cpu: number;
	net: number;
}

export class UsageDatabase extends AbstractDatabase {
	private windowStart(): number {
		return Math.floor(Date.now() / 1000) - PROVIDER_USAGE_WINDOW_HOURS * 3600;
	}

	async getUsage(account: string): Promise<AccountUsage> {
		const result = database
			.select({
				cpu: sql<number>`coalesce(sum(${this.schema.usage.cpu}), 0)`,
				net: sql<number>`coalesce(sum(${this.schema.usage.net}), 0)`
			})
			.from(this.schema.usage)
			.where(
				and(
					eq(this.schema.usage.account, account),
					gt(this.schema.usage.created_at, this.windowStart())
				)
			)
			.get();

		return {
			account,
			cpu: result?.cpu ?? 0,
			net: result?.net ?? 0
		};
	}

	async incrementUsage(account: string, cpu: number, net: number): Promise<void> {
		database
			.insert(this.schema.usage)
			.values({ account, cpu, net, created_at: Math.floor(Date.now() / 1000) })
			.run();
	}

	reserveRamSponsorship(
		account: string,
		bytes: number,
		accountLimit: number,
		globalLimit: number
	): boolean {
		if (!Number.isSafeInteger(bytes) || bytes <= 0) return false;
		const windowStart = this.windowStart();
		return database.transaction((transaction) => {
			const accountUsage = transaction
				.select({ bytes: sql<number>`coalesce(sum(${this.schema.ramSponsorship.bytes}), 0)` })
				.from(this.schema.ramSponsorship)
				.where(
					and(
						eq(this.schema.ramSponsorship.account, account),
						gt(this.schema.ramSponsorship.created_at, windowStart)
					)
				)
				.get();
			const globalUsage = transaction
				.select({ bytes: sql<number>`coalesce(sum(${this.schema.ramSponsorship.bytes}), 0)` })
				.from(this.schema.ramSponsorship)
				.where(gt(this.schema.ramSponsorship.created_at, windowStart))
				.get();
			if (
				(accountUsage?.bytes ?? 0) + bytes > accountLimit ||
				(globalUsage?.bytes ?? 0) + bytes > globalLimit
			) {
				return false;
			}
			transaction
				.insert(this.schema.ramSponsorship)
				.values({ account, bytes, created_at: Math.floor(Date.now() / 1000) })
				.run();
			return true;
		});
	}

	async cleanupExpired(): Promise<void> {
		database
			.delete(this.schema.usage)
			.where(lt(this.schema.usage.created_at, this.windowStart()))
			.run();
		database
			.delete(this.schema.ramSponsorship)
			.where(lt(this.schema.ramSponsorship.created_at, this.windowStart()))
			.run();
	}

	async resetAllUsage(): Promise<void> {
		database.delete(this.schema.usage).run();
		database.delete(this.schema.ramSponsorship).run();
	}
}

export const usageDatabase = new UsageDatabase();
