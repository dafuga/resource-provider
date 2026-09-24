CREATE TABLE `ram_sponsorship` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account` text NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_ram_sponsorship_account_created` ON `ram_sponsorship` (`account`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_ram_sponsorship_created` ON `ram_sponsorship` (`created_at`);