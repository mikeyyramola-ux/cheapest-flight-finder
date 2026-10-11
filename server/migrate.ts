import { warnAndPage } from "./alerts";
import { sql } from "drizzle-orm";

/**
 * Runtime migration for columns the deploy pipeline cannot add for us.
 *
 * WHY THIS EXISTS: `pnpm db:push` is not part of the Vercel build, and the agent
 * has no DATABASE_URL locally (and may not fetch one - Rule C). A schema change
 * committed alone would therefore ship code that references a column the live
 * table does not have, and the first subscriber to save a route would 500.
 * Running the ALTER here means the deploy applies its own schema, once, safely.
 *
 * This module deliberately does NOT import db.ts. It receives the instance, so
 * db.ts can import it and await it inside getDb() - which is what guarantees the
 * columns exist before ANY user read runs. Importing getDb here would make the
 * two files depend on each other.
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
 */

/**
 * Drizzle's mysql2 `execute()` returns a TUPLE - `[rows, fields]` - not the rows
 * themselves. Reading `result[0]` as if it were a row silently yields undefined
 * for every column, which makes a COUNT(*) probe always report 0 and the ALTER
 * retry forever without ever succeeding. Everything below unwraps that tuple
 * explicitly, and tolerates a driver that hands back rows directly.
 */
type AnyResult = unknown;

function unwrapRows(result: AnyResult): Array<Record<string, unknown>> {
  if (Array.isArray(result)) {
    // Tuple form: [rows, fields]. The rows element is itself an array.
    const first = result[0];
    if (Array.isArray(first)) return first as Array<Record<string, unknown>>;
    // Some paths return the rows array directly.
    if (result.every(item => item && typeof item === "object")) return result as Array<Record<string, unknown>>;
    return [];
  }
  if (result && typeof result === "object") {
    const maybe = (result as { rows?: unknown }).rows;
    if (Array.isArray(maybe)) return maybe as Array<Record<string, unknown>>;
  }
  return [];
}

/** Pulls a COUNT(*) out of a probe result regardless of the column's casing. */
function readCount(result: AnyResult): number {
  const rows = unwrapRows(result);
  const row = rows[0] ?? {};
  for (const key of Object.keys(row)) {
    if (key.toLowerCase() === "n") {
      const value = Number(row[key]);
      return Number.isFinite(value) ? value : 0;
    }
  }
  return 0;
}

type ColumnTask = { table: string; column: string; ddl: string };
type IndexTask = { table: string; index: string; ddl: string };

const IDENT = /^[A-Za-z0-9_]+$/;

const COLUMN_TASKS: ColumnTask[] = [
  // GO 167 - route ownership. Nullable so the existing demo rows survive.
  { table: "trackedRoute", column: "userId", ddl: "ALTER TABLE `trackedRoute` ADD COLUMN `userId` int" },
  // GO 167 - first-party password login. OAuth users simply leave it null.
  { table: "users", column: "passwordHash", ddl: "ALTER TABLE `users` ADD COLUMN `passwordHash` text" },
  // GO 167 - alert delivery target, so a drop reaches the customer.
  { table: "users", column: "telegramChatId", ddl: "ALTER TABLE `users` ADD COLUMN `telegramChatId` varchar(64)" },
];

const INDEX_TASKS: IndexTask[] = [
  { table: "trackedRoute", index: "trackedRoute_userId_idx", ddl: "ALTER TABLE `trackedRoute` ADD INDEX `trackedRoute_userId_idx` (`userId`)" },
];

let migrationRun: Promise<boolean> | null = null;

type Db = NonNullable<Awaited<ReturnType<typeof import("./db").getDb>>>;

/**
 * MySQL duplicate-column (1060) and duplicate-key (1061) are SUCCESS for an
 * additive migration: they mean another instance won the race and the schema is
 * already where this statement wanted it. Only anything else is a real failure.
 */
function isAlreadyApplied(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /1060|1061|duplicate column|duplicate key|already exists/i.test(message);
}

async function columnExists(db: Db, table: string, column: string): Promise<boolean> {
  if (!IDENT.test(table) || !IDENT.test(column)) return false;
  // `sql.raw` is the supported way to interpolate an identifier we control; a
  // bound parameter cannot stand in for a table name. Both values are validated
  // against the strict IDENT pattern above first.
  const result = await db.execute(sql.raw(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND COLUMN_NAME = '${column}'`,
  ));
  return readCount(result) > 0;
}

async function indexExists(db: Db, table: string, index: string): Promise<boolean> {
  if (!IDENT.test(table) || !IDENT.test(index)) return false;
  const result = await db.execute(sql.raw(
    `SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND INDEX_NAME = '${index}'`,
  ));
  // A composite index contributes one row per column; one row is enough to prove it.
  return readCount(result) > 0;
}

async function runMigration(db: Db): Promise<boolean> {
  let changed = false;

  for (const task of COLUMN_TASKS) {
    try {
      if (await columnExists(db, task.table, task.column)) continue;
      await db.execute(sql.raw(task.ddl));
      changed = true;
    } catch (error) {
      // A concurrent cold start may have added it between probe and ALTER. That is
      // the schema being correct, not the migration failing.
      if (isAlreadyApplied(error)) continue;
      warnAndPage("db:migrate-column", `[migrate] ${task.table}.${task.column} failed:`, error instanceof Error ? error.message : String(error));
    }
  }

  for (const task of INDEX_TASKS) {
    try {
      if (await indexExists(db, task.table, task.index)) continue;
      await db.execute(sql.raw(task.ddl));
      changed = true;
    } catch (error) {
      if (isAlreadyApplied(error)) continue;
      warnAndPage("db:migrate-index", `[migrate] ${task.table}.${task.index} failed:`, error instanceof Error ? error.message : String(error));
    }
  }

  return changed;
}

/**
 * Applies pending additive migrations, once per instance.
 *
 * Called from `getDb()` and awaited there, so the very first user read is
 * guaranteed the columns exist. Memoised on the module: the probe round-trip
 * happens once per cold start, not once per request.
 */
export function ensureSchema(db: Db): Promise<boolean> {
  if (!migrationRun) {
    migrationRun = runMigration(db).catch(error => {
      warnAndPage("db:migrate", "[migrate] run failed:", error instanceof Error ? error.message : String(error));
      return false;
    });
  }
  return migrationRun;
}
