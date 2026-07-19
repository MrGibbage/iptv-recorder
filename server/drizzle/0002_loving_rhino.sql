CREATE TABLE `recurring_rule_skips` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rule_id` integer NOT NULL,
	`occurrence_date` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `recurring_rules`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recurring_rule_skips_rule_date_idx` ON `recurring_rule_skips` (`rule_id`,`occurrence_date`);--> statement-breakpoint
CREATE TABLE `recurring_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_id` integer NOT NULL,
	`channel_id` text NOT NULL,
	`days_of_week` integer NOT NULL,
	`start_minute_of_day` integer NOT NULL,
	`duration_minutes` integer NOT NULL,
	`end_date` integer,
	`max_occurrences` integer,
	`cancelled_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE no action
);
