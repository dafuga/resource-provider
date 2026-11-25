CREATE TABLE `payer_funding` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`funder` text NOT NULL,
	`recipient` text NOT NULL,
	`units` integer NOT NULL,
	`reserved_at` integer NOT NULL,
	`transaction_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_payer_funding_source_time` ON `payer_funding` (`funder`,`reserved_at`);