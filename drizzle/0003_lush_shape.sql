CREATE TABLE `priceHistory` (
	`id` int AUTO_INCREMENT NOT NULL,
	`origin` varchar(8) NOT NULL,
	`destination` varchar(8) NOT NULL,
	`departDate` varchar(10),
	`price` int NOT NULL,
	`currency` varchar(8) NOT NULL DEFAULT 'USD',
	`provider` varchar(64) NOT NULL,
	`source` enum('live','seed','estimate') NOT NULL DEFAULT 'live',
	`purpose` varchar(16),
	`routeId` varchar(64),
	`capturedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `priceHistory_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `trackedRoute` (
	`id` varchar(64) NOT NULL,
	`origin` varchar(8) NOT NULL,
	`destination` varchar(8) NOT NULL,
	`departDate` varchar(10) NOT NULL,
	`returnDate` varchar(10),
	`targetPrice` int NOT NULL,
	`currentPrice` int NOT NULL,
	`status` enum('watching','alert') NOT NULL DEFAULT 'watching',
	`alertChannel` enum('Telegram','WhatsApp') NOT NULL DEFAULT 'Telegram',
	`lastCheckedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `trackedRoute_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `paypalSubscriptionId` varchar(128);--> statement-breakpoint
CREATE INDEX `priceHistory_od_time_idx` ON `priceHistory` (`origin`,`destination`,`capturedAt`);--> statement-breakpoint
CREATE INDEX `priceHistory_provider_idx` ON `priceHistory` (`provider`);--> statement-breakpoint
CREATE INDEX `trackedRoute_od_idx` ON `trackedRoute` (`origin`,`destination`);