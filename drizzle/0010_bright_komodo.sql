CREATE TABLE `provider_bucket_member` (
	`bucket` text NOT NULL,
	`account` text NOT NULL,
	PRIMARY KEY(`bucket`, `account`)
);
--> statement-breakpoint
ALTER TABLE `provider_bucket` ADD `members_only` integer DEFAULT false NOT NULL;