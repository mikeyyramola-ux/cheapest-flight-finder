import { index, int, mysqlEnum, mysqlTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  stripeCustomerId: varchar("stripeCustomerId", { length: 128 }),
  stripeSubscriptionId: varchar("stripeSubscriptionId", { length: 128 }),
  paypalSubscriptionId: varchar("paypalSubscriptionId", { length: 128 }),
  subscriptionStatus: varchar("subscriptionStatus", { length: 32 }).default("free").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const partnerHealth = mysqlTable("partnerHealth", {
  id: int("id").autoincrement().primaryKey(),
  key: varchar("key", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 128 }).notNull(),
  category: varchar("category", { length: 32 }).notNull(),
  url: text("url").notNull(),
  status: mysqlEnum("status", ["up", "degraded", "down"]).default("down").notNull(),
  httpStatus: int("httpStatus"),
  latencyMs: int("latencyMs"),
  totalChecks: int("totalChecks").default(0).notNull(),
  totalFailures: int("totalFailures").default(0).notNull(),
  consecutiveFailures: int("consecutiveFailures").default(0).notNull(),
  lastError: text("lastError"),
  lastCheckedAt: timestamp("lastCheckedAt"),
  lastSuccessAt: timestamp("lastSuccessAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => ({
  statusIdx: index("partnerHealth_status_idx").on(table.status),
}));

/**
 * Durable copy of a customer's tracked route.
 *
 * The previous store was an in-process Map, which is wiped on every serverless cold
 * start - a saved route, its alert target and its price silently vanished and were
 * re-seeded with sample values. This table is the source of truth; the Map is only a
 * cache of it.
 */
export const trackedRoute = mysqlTable("trackedRoute", {
  id: varchar("id", { length: 64 }).primaryKey(),
  origin: varchar("origin", { length: 8 }).notNull(),
  destination: varchar("destination", { length: 8 }).notNull(),
  departDate: varchar("departDate", { length: 10 }).notNull(),
  returnDate: varchar("returnDate", { length: 10 }),
  targetPrice: int("targetPrice").notNull(),
  currentPrice: int("currentPrice").notNull(),
  status: mysqlEnum("status", ["watching", "alert"]).default("watching").notNull(),
  alertChannel: mysqlEnum("alertChannel", ["Telegram", "WhatsApp"]).default("Telegram").notNull(),
  lastCheckedAt: timestamp("lastCheckedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => ({
  odIdx: index("trackedRoute_od_idx").on(table.origin, table.destination),
}));

/**
 * The price-history asset: one row per real observation, tagged with the supplier that
 * produced it.
 *
 * Sample/seed numbers are deliberately never written here. Every row must carry a
 * `provider`, so a chart can never blend two suppliers or present invented data as an
 * airline quote. Reads additionally filter `source = 'live'` as a second guard.
 */
export const priceHistory = mysqlTable("priceHistory", {
  id: int("id").autoincrement().primaryKey(),
  origin: varchar("origin", { length: 8 }).notNull(),
  destination: varchar("destination", { length: 8 }).notNull(),
  departDate: varchar("departDate", { length: 10 }),
  price: int("price").notNull(),
  currency: varchar("currency", { length: 8 }).default("USD").notNull(),
  /** Which supplier produced this observation, e.g. "scrappa" / "ignav". */
  provider: varchar("provider", { length: 64 }).notNull(),
  source: mysqlEnum("source", ["live", "seed", "estimate"]).default("live").notNull(),
  purpose: varchar("purpose", { length: 16 }),
  routeId: varchar("routeId", { length: 64 }),
  capturedAt: timestamp("capturedAt").defaultNow().notNull(),
}, table => ({
  odTimeIdx: index("priceHistory_od_time_idx").on(table.origin, table.destination, table.capturedAt),
  providerIdx: index("priceHistory_provider_idx").on(table.provider),
}));

/**
 * Month-wide ledger of credits we have actually spent with each supplier.
 *
 * None of our suppliers expose a usage endpoint, so the provider's own dashboard can
 * never tell us how close we are to the free ceiling. This table is therefore the
 * ONLY thing that can warn us before the pool runs dry - and running dry means a
 * subscriber's price-drop alert goes unsent.
 *
 * One row per (supplier, period): `period` is `YYYY-MM` for refilling pools and
 * `lifetime` for the one-time pools. Incremented at the point a request is billed,
 * never on failure, so the count tracks real spend rather than attempts.
 */
export const creditUsage = mysqlTable("creditUsage", {
  id: int("id").autoincrement().primaryKey(),
  /** Billing identity, e.g. "Scrappa (Google Flights)", "Ignav", "Bright Data". */
  provider: varchar("provider", { length: 64 }).notNull(),
  /** `2026-09` for a monthly allowance, `lifetime` for a one-time allowance. */
  period: varchar("period", { length: 16 }).notNull(),
  used: int("used").default(0).notNull(),
  creditLimit: int("creditLimit").notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => ({
  providerPeriodUq: uniqueIndex("creditUsage_provider_period_uq").on(table.provider, table.period),
}));

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type TrackedRouteRow = typeof trackedRoute.$inferSelect;
export type InsertTrackedRoute = typeof trackedRoute.$inferInsert;
export type PriceHistoryRow = typeof priceHistory.$inferSelect;
export type InsertPriceHistory = typeof priceHistory.$inferInsert;
