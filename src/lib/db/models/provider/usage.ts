import { and, eq, gt, lt, sql } from 'drizzle-orm';

import { database } from '$lib/db';
import { AbstractDatabase } from '$lib/db/abstract';
import { getInt } from '$lib/settings';

export interface AccountUsage {
	account: string;
	cpu: number;
	net: number;
}

export class UsageDatabase extends AbstractDatabase {
	private windowStart(): number {
		return Math.floor(Date.now() / 1000) - getInt('provider.usage.window_hours') * 3600;
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

	getBucketUsage(account: string, bucket: string): { cpu: number; net: number } {
		const result = database
			.select({
				cpu: sql<number>`coalesce(sum(${this.schema.usage.cpu}), 0)`,
				net: sql<number>`coalesce(sum(${this.schema.usage.net}), 0)`
			})
			.from(this.schema.usage)
			.where(
				and(
					eq(this.schema.usage.account, account),
					eq(this.schema.usage.bucket, bucket),
					gt(this.schema.usage.created_at, this.windowStart())
				)
			)
			.get();
		return { cpu: result?.cpu ?? 0, net: result?.net ?? 0 };
	}

	async incrementUsage(
		account: string,
		cpu: number,
		net: number,
		bucket = 'wildcard'
	): Promise<void> {
		database
			.insert(this.schema.usage)
			.values({ account, cpu, net, bucket, created_at: Math.floor(Date.now() / 1000) })
			.run();
	}

	getUsageByBucket(account: string): Array<{ bucket: string; cpu: number; net: number }> {
		return database
			.select({
				bucket: this.schema.usage.bucket,
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
			.groupBy(this.schema.usage.bucket)
			.all();
	}

	purgeBucket(bucket: string): number {
		const result = database
			.delete(this.schema.usage)
			.where(eq(this.schema.usage.bucket, bucket))
			.run();
		return result.changes;
	}

	async cleanupExpired(): Promise<number> {
		const result = database
			.delete(this.schema.usage)
			.where(lt(this.schema.usage.created_at, this.windowStart()))
			.run();
		return result.changes;
	}

	async resetAllUsage(): Promise<void> {
		database.delete(this.schema.usage).run();
	}
}

export const usageDatabase = new UsageDatabase();
