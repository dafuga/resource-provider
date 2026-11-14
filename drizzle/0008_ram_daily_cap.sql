CREATE TABLE `ram_purchases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account` text NOT NULL,
	`bytes` integer NOT NULL,
	`cost` real NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_ram_purchases_account_created` ON `ram_purchases` (`account`,`created_at`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `ram_daily_max_fee` real DEFAULT 0 NOT NULL;