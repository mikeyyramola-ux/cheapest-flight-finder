CREATE TABLE `creditUsage` (
	`id` int AUTO_INCREMENT NOT NULL,
	`provider` varchar(64) NOT NULL,
	`period` varchar(16) NOT NULL,
	`used` int NOT NULL DEFAULT 0,
	`creditLimit` int NOT NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `creditUsage_id` PRIMARY KEY(`id`),
	CONSTRAINT `creditUsage_provider_period_uq` UNIQUE(`provider`,`period`)
);
