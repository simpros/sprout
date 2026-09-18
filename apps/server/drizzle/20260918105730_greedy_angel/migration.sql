PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_previews` (
	`canonical_repo_id` text NOT NULL,
	`pr_id` integer NOT NULL,
	`slug` text NOT NULL,
	`db_name` text,
	`db_provider` text DEFAULT 'postgres' NOT NULL,
	`hostname` text NOT NULL,
	`app_image` text,
	`container_id` text,
	`status` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`seeded_at` text,
	`seeded_seed_image` text,
	`last_error` text,
	`last_error_detail` text,
	`failure_family` text,
	`bring_up_plan` text,
	`seed_log` text,
	CONSTRAINT `previews_pk` PRIMARY KEY(`canonical_repo_id`, `pr_id`)
);
--> statement-breakpoint
INSERT INTO `__new_previews`(`canonical_repo_id`, `pr_id`, `slug`, `db_name`, `db_provider`, `hostname`, `app_image`, `container_id`, `status`, `created_at`, `updated_at`, `seeded_at`, `seeded_seed_image`, `last_error`, `last_error_detail`, `failure_family`, `bring_up_plan`, `seed_log`) SELECT `canonical_repo_id`, `pr_id`, `slug`, `db_name`, `db_provider`, `hostname`, `app_image`, `container_id`, `status`, `created_at`, `updated_at`, `seeded_at`, `seeded_seed_image`, `last_error`, `last_error_detail`, `failure_family`, `bring_up_plan`, `seed_log` FROM `previews`;--> statement-breakpoint
DROP TABLE `previews`;--> statement-breakpoint
ALTER TABLE `__new_previews` RENAME TO `previews`;--> statement-breakpoint
PRAGMA foreign_keys=ON;