CREATE TABLE `clients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`api_key_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
