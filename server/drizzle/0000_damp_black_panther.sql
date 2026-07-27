CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`tracker_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`type` text NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer,
	`values` text DEFAULT '{}' NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tracker_id`) REFERENCES `trackers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `events_profile_start_idx` ON `events` (`profile_id`,`start_at`);--> statement-breakpoint
CREATE INDEX `events_tracker_idx` ON `events` (`tracker_id`);--> statement-breakpoint
CREATE INDEX `events_running_idx` ON `events` (`profile_id`,`type`,`end_at`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`colour` text NOT NULL,
	`icon` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trackers` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`colour` text NOT NULL,
	`icon` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`fields` text DEFAULT '[]' NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `trackers_profile_id_idx` ON `trackers` (`profile_id`);