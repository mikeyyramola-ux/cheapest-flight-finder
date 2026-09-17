import { and, eq } from "drizzle-orm";
import { partnerHealth } from "../drizzle/schema";
import { getDb } from "./db";

export const PARTNER_ENDPOINTS = [
  { key: "kiwi-affiliate", name: "Kiwi affiliate booking", category: "affiliate", url: "https://kiwi.tpk.lu/BqdFdqYN" },
  { key: "booking-partner", name: "Booking.com stays", category: "partner", url: "https://www.booking.com/" },
  { key: "rentalcars-partner", name: "Rentalcars.com cars", category: "partner", url: "https://www.rentalcars.com/" },
] as const;

const REQUEST_TIMEOUT_MS = 8_000;

export type PartnerHealthResult = typeof PARTNER_ENDPOINTS[number] & {
  status: "up" | "degraded" | "down";
  httpStatus: number | null;
  latencyMs: number | null;
  error: string | null;
  checkedAt: string;
};

async function checkEndpoint(endpoint: typeof PARTNER_ENDPOINTS[number]): Promise<PartnerHealthResult> {
  const started = Date.now();
  try {
    const response = await fetch(endpoint.url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "user-agent": "Faredrop-HealthMonitor/1.0" },
    });
    const latencyMs = Date.now() - started;
    const status = response.status >= 500 ? "down" : response.status >= 400 ? "degraded" : latencyMs > 3_000 ? "degraded" : "up";
    return { ...endpoint, status, httpStatus: response.status, latencyMs, error: status === "up" ? null : `HTTP ${response.status}`, checkedAt: new Date().toISOString() };
  } catch (error) {
    return { ...endpoint, status: "down", httpStatus: null, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString() };
  }
}

export async function checkPartnerEndpoints() {
  const results = await Promise.all(PARTNER_ENDPOINTS.map(checkEndpoint));
  const db = await getDb();
  if (db) {
    for (const result of results) {
      const previous = await db.select().from(partnerHealth).where(eq(partnerHealth.key, result.key)).limit(1);
      const previousRow = previous[0];
      const failed = result.status !== "up";
      const totalChecks = (previousRow?.totalChecks ?? 0) + 1;
      const totalFailures = (previousRow?.totalFailures ?? 0) + (failed ? 1 : 0);
      const consecutiveFailures = failed ? (previousRow?.consecutiveFailures ?? 0) + 1 : 0;
      const values = {
        key: result.key,
        name: result.name,
        category: result.category,
        url: result.url,
        status: result.status,
        httpStatus: result.httpStatus,
        latencyMs: result.latencyMs,
        totalChecks,
        totalFailures,
        consecutiveFailures,
        lastError: result.error,
        lastCheckedAt: new Date(result.checkedAt),
        lastSuccessAt: failed ? (previousRow?.lastSuccessAt ?? null) : new Date(result.checkedAt),
      };
      await db.insert(partnerHealth).values(values).onDuplicateKeyUpdate({ set: values });
    }
  }
  return { checkedAt: new Date().toISOString(), results };
}

export async function getPartnerHealthReport() {
  const db = await getDb();
  if (!db) return { monitored: PARTNER_ENDPOINTS, persisted: false };
  const rows = await db.select().from(partnerHealth);
  return { monitored: rows, persisted: true };
}
