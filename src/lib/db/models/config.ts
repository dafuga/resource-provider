import { and, eq } from 'drizzle-orm';

import { database } from '$lib/db';
import { AbstractDatabase } from '$lib/db/abstract';

export interface ConfigRow {
	scope: string;
	key: string;
	value: string;
	updated_at: number;
}

export class ConfigDatabase extends AbstractDatabase {
	getAll(scope = 'global'): ConfigRow[] {
		return database
			.select()
			.from(this.schema.config)
			.where(eq(this.schema.config.scope, scope))
			.all();
	}

	get(key: string, scope = 'global'): ConfigRow | undefined {
		return database
			.select()
			.from(this.schema.config)
			.where(and(eq(this.schema.config.scope, scope), eq(this.schema.config.key, key)))
			.get();
	}

	set(key: string, value: string, scope = 'global'): void {
		const updated_at = Math.floor(Date.now() / 1000);
		database
			.insert(this.schema.config)
			.values({ scope, key, value, updated_at })
			.onConflictDoUpdate({
				target: [this.schema.config.scope, this.schema.config.key],
				set: { value, updated_at }
			})
			.run();
	}

	unset(key: string, scope = 'global'): void {
		database
			.delete(this.schema.config)
			.where(and(eq(this.schema.config.scope, scope), eq(this.schema.config.key, key)))
			.run();
	}
}

export const configDatabase = new ConfigDatabase();
