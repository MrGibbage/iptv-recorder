PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'xtream' NOT NULL,
	`base_url` text,
	`username_encrypted` text,
	`password_encrypted` text,
	`playlist_url_encrypted` text,
	`epg_url_encrypted` text,
	`max_concurrent_streams` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "providers_type_shape" CHECK(
        ("__new_providers"."type" = 'xtream'
          AND "__new_providers"."base_url" IS NOT NULL
          AND "__new_providers"."username_encrypted" IS NOT NULL
          AND "__new_providers"."password_encrypted" IS NOT NULL
          AND "__new_providers"."playlist_url_encrypted" IS NULL)
        OR
        ("__new_providers"."type" = 'm3u'
          AND "__new_providers"."playlist_url_encrypted" IS NOT NULL
          AND "__new_providers"."base_url" IS NULL
          AND "__new_providers"."username_encrypted" IS NULL
          AND "__new_providers"."password_encrypted" IS NULL)
      )
);
--> statement-breakpoint
-- Note: hand-edited from drizzle-kit's raw output. drizzle-kit generated an
-- INSERT that selected "type", "playlist_url_encrypted", "epg_url_encrypted"
-- from the OLD `providers` table, which doesn't have those columns yet.
-- SQLite's double-quoted-identifier fallback silently turned those into
-- string literals (e.g. type = 'type') instead of erroring, which then
-- failed the new CHECK constraint. Fixed by only copying columns that
-- existed on the old table; the new columns take their correct defaults
-- (type -> 'xtream', the two new *_encrypted columns -> NULL), which is
-- exactly right since every existing row is Xtream-shaped.
INSERT INTO `__new_providers`("id", "name", "base_url", "username_encrypted", "password_encrypted", "max_concurrent_streams", "enabled", "created_at", "updated_at") SELECT "id", "name", "base_url", "username_encrypted", "password_encrypted", "max_concurrent_streams", "enabled", "created_at", "updated_at" FROM `providers`;--> statement-breakpoint
DROP TABLE `providers`;--> statement-breakpoint
ALTER TABLE `__new_providers` RENAME TO `providers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;