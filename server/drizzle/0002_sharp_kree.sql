PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_reminders` (
	`id` text PRIMARY KEY NOT NULL,
	`tracker_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`kind` text DEFAULT 'IDLE' NOT NULL,
	`after_ms` integer,
	`quiet_from_min` integer,
	`quiet_to_min` integer,
	`days` text,
	`times_min` text,
	`time_zone` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_fired_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tracker_id`) REFERENCES `trackers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- HAND-EDITED. drizzle-kit generated this INSERT selecting "kind", "days" and
-- "times_min" from the OLD table, where those three columns do not exist yet —
-- as generated it fails with `no such column: kind` and the reminders table is
-- left dropped. Every pre-existing reminder is an idle one, so `kind` is
-- literal 'IDLE' and the two SCHEDULE columns are literal NULL; every other
-- value is carried across untouched.
INSERT INTO `__new_reminders`("id", "tracker_id", "profile_id", "kind", "after_ms", "quiet_from_min", "quiet_to_min", "days", "times_min", "time_zone", "enabled", "last_fired_at", "created_at", "updated_at") SELECT "id", "tracker_id", "profile_id", 'IDLE', "after_ms", "quiet_from_min", "quiet_to_min", NULL, NULL, "time_zone", "enabled", "last_fired_at", "created_at", "updated_at" FROM `reminders`;--> statement-breakpoint
DROP TABLE `reminders`;--> statement-breakpoint
ALTER TABLE `__new_reminders` RENAME TO `reminders`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `reminders_tracker_idx` ON `reminders` (`tracker_id`);--> statement-breakpoint
CREATE INDEX `reminders_profile_idx` ON `reminders` (`profile_id`);--> statement-breakpoint
CREATE INDEX `reminders_enabled_idx` ON `reminders` (`enabled`);