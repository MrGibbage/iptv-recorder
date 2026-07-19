CREATE TABLE `recordings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_id` integer NOT NULL,
	`channel_id` text NOT NULL,
	`recurring_rule_id` integer,
	`start_time` integer NOT NULL,
	`end_time` integer NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`file_path` text,
	`failure_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recurring_rule_id`) REFERENCES `recurring_rules`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recordings_end_after_start" CHECK("recordings"."end_time" > "recordings"."start_time")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recordings_rule_start_idx` ON `recordings` (`recurring_rule_id`,`start_time`);