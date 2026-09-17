CREATE TABLE `partnerHealth` (
	`id` int AUTO_INCREMENT NOT NULL,
	`key` varchar(64) NOT NULL,
	`name` varchar(128) NOT NULL,
	`category` varchar(32) NOT NULL,
	`url` text NOT NULL,
	`status` enum('up','degraded','down') NOT NULL DEFAULT 'down',
	`httpStatus` int,
	`latencyMs` int,
	`totalChecks` int NOT NULL DEFAULT 0,
	`totalFailures` int NOT NULL DEFAULT 0,
	`consecutiveFailures` int NOT NULL DEFAULT 0,
	`lastError` text,
	`lastCheckedAt` timestamp,
	`lastSuccessAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `partnerHealth_id` PRIMARY KEY(`id`),
	CONSTRAINT `partnerHealth_key_unique` UNIQUE(`key`)
);
--> statement-breakpoint
CREATE INDEX `partnerHealth_status_idx` ON `partnerHealth` (`status`);