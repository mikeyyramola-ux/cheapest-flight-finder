import { warnAndPage } from "./alerts";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, users } from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      warnAndPage("db:connect", "[Database] Failed to connect:", error);
      _db = null;
    }
  }
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
