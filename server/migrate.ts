import { warnAndPage } from "./alerts";
import { getDb } from "./db";

/**
 * Runtime migration for columns the deploy pipeline cannot add for us.
 *
 * WHY THIS EXISTS: `pnpm db:push` is not part of the Vercel build, and the agent
 * has no DATABASE_URL locally (and may not fetch one - Rule C). A schema change
 * committed alone would therefore ship code that references a column the live
 * table does not have, and the first subscriber to save a route would 500.
 * Running the ALTER here means the deploy applies its own schema, once, safely.
 *
 * THREE RULES THIS FOLLOWS:
 *  1. Idempotent. Every statement is guarded by an information_schema probe, so a
 *     cold start never re-runs an ALTER or errors on a column that already exists.
 *     MySQL has no `ADD COLUMN IF NOT EXISTS`, hence the probe.
 *  2. Additive only. New nullable columns and indexes. No drop, no rename, no
 *     rewrite of existing rows - a live table with customer routes is never at
 *     risk from this file.
 *  3. Never fatal. A migration failure is paged to the owner and swallowed. The
 *     app keeps serving; the affected writes degrade the way price-store already
 *     degrades. Blocking every search because an ALTER failed would turn a
 *     one-column problem into a full outage.
 *
 * The whole run is memoised on the module so it happens at most once per
 * instance, and only ever when a database is actually configured.
 */

type ColumnTask = { table: string; column: string; ddl: string };
type IndexTask = { table: string; index: string; ddl: string };

const COLUMN_TASKS: ColumnTask[] = [
  // GO 167 - route ownership. Nullable so the existing demo rows survive.
  {
    table: "trackedRoute",
    column: "userId",
    ddl: "ALTER TABLE `trackedRoute` ADD COLUMN `userId` int",
  },
  // GO 167 - first-party password login. OAuth users simply leave it null.
  {
    table: "users",
    column: "passwordHash",
    ddl: "ALTER TABLE `users` ADD COLUMN `passwordHash` text",
  },
  // GO 167 - alert delivery target, so a drop reaches the customer.
  {
    table: "users",
    column: "telegramChatId",
    ddl: "ALTER TABLE `users` ADD COLUMN `telegramChatId` varchar(64)",
  },
];

const INDEX_TASKS: IndexTask[] = [
  {
    table: "trackedRoute",
    index: "trackedRoute_userId_idx",
    ddl: "ALTER TABLE `trackedRoute` ADD INDEX `trackedRoute_userId_idx` (`userId`)",
  },
];

let migrationRun: Promise<boolean> | null = null;

async function columnExists(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  table: string,
  column: string,
): Promise<boolean | null> {
  // information_schema identifiers cannot be bound as parameters, so both values
  // are validated against the strict shape we control before being interpolated.
  if (!/^[A-Za-z0-9_]+$/.test(table) || !/^[A-Za-z0-9_]+$/.test(column)) return null;
  const rows = await db.execute(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND COLUMN_NAME = '${column}'`,
  );
  const raw = (rows as unknown as Array<Record<string, unknown>>)[0];
  const value = raw?.n ?? raw?.N ?? raw?.["COUNT(*)"] ?? 0;
  return Number(value) > 0;
}

async function indexExists(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  table: string,
  index: string,
): Promise<boolean | null> {
  if (!/^[A-Za-z0-9_]+$/.test(table) || !/^[A-Za-z0-9_]+$/.test(index)) return null;
  const rows = await db.execute(
    `SELECT COUNT(*) AS n FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND INDEX_NAME = '${index}'`,
  );
  const raw = (rows as unknown as Array<Record<string, unknown>>)[0];
  const value = raw?.n ?? raw?.N ?? raw?.["COUNT(*)"] ?? 0;
  // A composite index contributes one row per column; one row is enough to prove it.
  return Number(value) > 0;
}

async function runMigration(): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  let added = 0;
  for (const task of COLUMN_TASKS) {
    try {
      const exists = await columnExists(db, task.table, task.column);
      if (exists === null) continue; // probe refused (bad identifier) - leave it alone
      if (exists) continue;
      await db.execute(task.ddl);
      added += 1;
    } catch (error) {
      // A concurrent cold start may have added it between probe and ALTER; that
      // error is expected and harmless. Anything else is paged, never thrown.
      warnAndPage("db:migrate-column", `[migrate] ${task.table}.${task.column} skipped:`, error instanceof Error ? error.message : String(error));
    }
  }

  for (const task of INDEX_TASKS) {
    try {
      const exists = await indexExists(db, task.table, task.index);
      if (exists === null || exists) continue;
      await db.execute(task.ddl);
      added += 1;
    } catch (error) {
      warnAndPage("db:migrate-index", `[migrate] ${task.table}.${task.index} skipped:`, error instanceof Error ? error.message : String(error));
    }
  }

  return added > 0;
}

/** Applies pending additive migrations once per instance. Safe to await anywhere. */
export function ensureSchema(): Promise<boolean> {
  if (!migrationRun) {
    migrationRun = runMigration().catch(error => {
      warnAndPage("db:migrate", "[migrate] run failed:", error instanceof Error ? error.message : String(error));
      return false;
    });
  }
  return migrationRun;
}
