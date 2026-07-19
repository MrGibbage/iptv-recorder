CREATE TABLE `retention_config` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ttl_days` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `storage_config` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`directory` text NOT NULL,
	`min_free_bytes` integer NOT NULL,
	`updated_at` integer NOT NULL
);
