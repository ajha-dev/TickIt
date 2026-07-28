ALTER TABLE `events` ADD `ticks` text;--> statement-breakpoint
ALTER TABLE `trackers` ADD `counter` integer DEFAULT false NOT NULL;