CREATE TABLE `profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `recordings` ADD `profile_id` integer REFERENCES profiles(id);--> statement-breakpoint
ALTER TABLE `recurring_rules` ADD `profile_id` integer REFERENCES profiles(id);