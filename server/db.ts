import { warnAndPage } from "./alerts";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, users } from "../drizzle/schema";
import { ensureSchema } from "./migrate";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;
let _schemaReady: Promise<unknown> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
//
// GO 167: the instance is only handed back AFTER the additive migration has run.
// This matters because Drizzle builds its SELECT list from the TypeScript schema,
// so a query as ordinary as `select ... from users` names `passwordHash` - and
// would fail against a table that predates it. Awaiting here means every caller,
// including `ctx.user` resolution on the hot path, sees a table that matches the
// code. The promise is memoised, so this costs one probe round trip per cold
// start rather than one per request.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      warnAndPage("db:connect", "[Database] Failed to connect:", error);
      _db = null;
    }
  }
  if (!_db) return null;

  if (!_schemaReady) {
    _schemaReady = ensureSchema(_db).catch(error => {
      warnAndPage("db:schema", "[Database] Schema migration failed:", error instanceof Error ? error.message : String(error));
    });
  }
  await _schemaReady;

  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    warnAndPage("db:upsert-user", "[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    warnAndPage("db:get-user", "[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

/**
 * Look up a user by email for first-party password login.
 *
 * `email` is not UNIQUE in this schema (OAuth providers may hand back several
 * identities for one address), so this returns the most recently created match
 * rather than asserting there is exactly one. Login additionally keys the session
 * on `openId`, which IS unique, so a duplicate address cannot merge two accounts.
 */
export async function getUserByEmail(email: string) {
  const db = await getDb();
  if (!db) {
    warnAndPage("db:get-user-by-email", "[Database] Cannot get user by email: database not available");
    return undefined;
  }

  const result = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .orderBy(desc(users.createdAt))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

/**
 * Creates a first-party email/password user.
 *
 * The insert keys on the derived `openId` (see `deriveOpenId`), which carries a
 * UNIQUE constraint - so the database, not application code, is what actually
 * prevents two people registering the same address. A concurrent duplicate raises
 * from the driver and is reported to the caller as "already registered".
 */
export async function createPasswordUser(input: {
  openId: string;
  email: string;
  name?: string | null;
  passwordHash: string;
  telegramChatId?: string | null;
}): Promise<{ ok: boolean; alreadyRegistered?: boolean }> {
  const db = await getDb();
  if (!db) {
    warnAndPage("db:create-user", "[Database] Cannot create user: database not available");
    return { ok: false };
  }

  try {
    await db.insert(users).values({
      openId: input.openId,
      email: input.email,
      name: input.name ?? null,
      passwordHash: input.passwordHash,
      telegramChatId: input.telegramChatId ?? null,
      loginMethod: "password",
      subscriptionStatus: "free",
    });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 1062 = MySQL duplicate entry. The unique openId is derived from the email,
    // so this is precisely the "address already registered" case.
    if (/duplicate|1062/i.test(message)) return { ok: false, alreadyRegistered: true };
    warnAndPage("db:create-user", "[Database] createPasswordUser failed:", message);
    return { ok: false };
  }
}

/** Stores a captured Telegram chat id so alerts reach the customer, not the owner. */
export async function setTelegramChatId(userId: number, chatId: string) {
  const db = await getDb();
  if (!db) return false;
  await db.update(users).set({ telegramChatId: chatId }).where(eq(users.id, userId));
  return true;
}

/**
 * Reads back the chat id captured at sign-up, so a price alert can be addressed
 * to the CUSTOMER who asked for it rather than to the owner's chat.
 *
 * Returns null rather than throwing when there is no database or no stored id:
 * a missing destination is a delivery failure to be reported, never a reason to
 * fail the surrounding scan, which is checking every other customer's routes too.
 */
export async function getTelegramChatIdForUser(userId: number | null | undefined): Promise<string | null> {
  if (userId == null) return null;

  const db = await getDb();
  if (!db) return null;

  try {
    const result = await db
      .select({ telegramChatId: users.telegramChatId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const chatId = result[0]?.telegramChatId;
    return typeof chatId === "string" && chatId.trim() ? chatId.trim() : null;
  } catch (error) {
    warnAndPage("db:get-telegram-chat-id", "[Database] Cannot read telegram chat id:", error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * Resolve a user from a payment-provider subscription id.
 *
 * Refund and failed-payment webhooks hand us a charge or an invoice, not a user id -
 * the only durable handle they carry is the subscription. Without this, a refund
 * cannot be attributed to anyone and premium access would survive it.
 *
 * Reads stripeSubscriptionId / paypalSubscriptionId, both of which already exist on
 * `users`. This is a read against existing columns: no schema change, no migration.
 */
export async function getUserBySubscriptionId(
  provider: "stripe" | "paypal",
  subscriptionId: string | null | undefined
) {
  if (!subscriptionId) return undefined;

  const db = await getDb();
  if (!db) {
    warnAndPage("db:get-user-by-subscription", "[Database] Cannot get user by subscription: database not available");
    return undefined;
  }

  const column = provider === "stripe" ? users.stripeSubscriptionId : users.paypalSubscriptionId;
  const result = await db.select().from(users).where(eq(column, subscriptionId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function updateUserStripeSubscription(input: {
  userId: number;
  customerId?: string | null;
  subscriptionId?: string | null;
  status: string;
}) {
  const db = await getDb();
  if (!db) {
    warnAndPage("db:persist-stripe", "[Database] Cannot persist Stripe subscription: database not available");
    return false;
  }

  await db.update(users).set({
    stripeCustomerId: input.customerId ?? undefined,
    stripeSubscriptionId: input.subscriptionId ?? undefined,
    subscriptionStatus: input.status,
  }).where(eq(users.id, input.userId));
  return true;
}

export async function updateUserPayPalSubscription(input: {
  userId: number;
  subscriptionId?: string | null;
  status: string;
}) {
  const db = await getDb();
  if (!db) {
    warnAndPage("db:persist-paypal", "[Database] Cannot persist PayPal subscription: database not available");
    return false;
  }

  await db.update(users).set({
    paypalSubscriptionId: input.subscriptionId ?? undefined,
    subscriptionStatus: input.status,
  }).where(eq(users.id, input.userId));
  return true;
}
