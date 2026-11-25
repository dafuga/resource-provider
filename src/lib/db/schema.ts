import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('accounts', {
	account: text('account').primaryKey(),
	min_ms: integer('min_ms').notNull(),
	min_kb: integer('min_kb').notNull(),
	min_ram_kb: integer('min_ram_kb').notNull().default(0),
	inc_ms: integer('inc_ms').notNull(),
	inc_kb: integer('inc_kb').notNull(),
	inc_ram_kb: integer('inc_ram_kb').notNull().default(0),
	max_fee: text('max_fee').notNull(),
	// Rolling 24h cap on estimated RAM spend for this account (system tokens). 0 = use default.
	ram_daily_max_fee: real('ram_daily_max_fee').notNull().default(0)
});

export const manager = sqliteTable('manager', {
	account: text('account').primaryKey(),
	permission: text('permission').notNull(),
	key: text('key').notNull()
});

export const provider = sqliteTable('provider', {
	account: text('account').primaryKey(),
	permission: text('permission').notNull(),
	key: text('key').notNull()
});

export const usage = sqliteTable(
	'usage',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		account: text('account').notNull(),
		cpu: integer('cpu').notNull(),
		net: integer('net').notNull(),
		created_at: integer('created_at').notNull()
	},
	(table) => [index('idx_usage_account_created').on(table.account, table.created_at)]
);

// Ledger of managed-account RAM purchases, so the daily cap survives restarts.
export const ramPurchases = sqliteTable(
	'ram_purchases',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		account: text('account').notNull(),
		bytes: integer('bytes').notNull(),
		cost: real('cost').notNull(),
		created_at: integer('created_at').notNull()
	},
	(table) => [index('idx_ram_purchases_account_created').on(table.account, table.created_at)]
);

// Record attempted transfers before broadcast, so unknown outcomes still count against the cap.
export const payerFunding = sqliteTable(
	'payer_funding',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		funder: text('funder').notNull(),
		recipient: text('recipient').notNull(),
		units: integer('units').notNull(),
		reserved_at: integer('reserved_at').notNull(),
		transaction_id: text('transaction_id')
	},
	(table) => [index('idx_payer_funding_source_time').on(table.funder, table.reserved_at)]
);
