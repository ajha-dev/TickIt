CREATE TABLE `push_subs` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subs_endpoint_idx` ON `push_subs` (`endpoint`);--> statement-breakpoint
CREATE TABLE `reminders` (
	`id` text PRIMARY KEY NOT NULL,
	`tracker_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`after_ms` integer NOT NULL,
	`quiet_from_min` integer,
	`quiet_to_min` integer,
	`time_zone` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_fired_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tracker_id`) REFERENCES `trackers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reminders_tracker_idx` ON `reminders` (`tracker_id`);--> statement-breakpoint
CREATE INDEX `reminders_profile_idx` ON `reminders` (`profile_id`);--> statement-breakpoint
CREATE INDEX `reminders_enabled_idx` ON `reminders` (`enabled`);