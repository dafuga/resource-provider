import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('accounts', {
	account: text('account').primaryKey(),
	min_ms: integer('min_ms').notNull(),
	min_kb: integer('min_kb').notNull(),
	min_ram_kb: integer('min_ram_kb').notNull().default(0),
	inc_ms: integer('inc_ms').notNull(),
	inc_kb: integer('inc_kb').notNull(),
	inc_ram_kb: integer('inc_ram_kb').notNull().default(0),
	max_fee: text('max_fee').notNull()
});

export const contracts = sqliteTable('contracts', {
	contract: text('contract').primaryKey(),
	abi: text('abi').notNull()
});

export const manager = sqliteTable('manager', {
	account: text('account').primaryKey(),
	permission: text('permission').notNull(),
	key: text('key').notNull()
});
