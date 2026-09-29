CREATE TABLE `pageView` (
	`id` int AUTO_INCREMENT NOT NULL,
	`site` varchar(16) NOT NULL,
	`day` varchar(10) NOT NULL,
	`path` varchar(255) NOT NULL,
	`hits` int NOT NULL DEFAULT 0,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `pageView_id` PRIMARY KEY(`id`),
	CONSTRAINT `pageView_site_day_path_uq` UNIQUE(`site`,`day`,`path`)
);
