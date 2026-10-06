/**
 * Supplier call telemetry (PROPOSAL 22).
 *
 * Why this exists: flight-data.ts throws away everything except the fares. A non-2xx
 * response is `if (!response.ok) return null` - the status is never read - and a
 * timeout lands in `catch { return null }`. So today we cannot answer "is Scrappa
 * 402-ing?" until E14/E3 fires on an empty pool, by which point the pool is already
 * empty. This module records the four things the provider-quality report asked for and
 * we had no way to produce: status-class counts, latency (median + worst), and how
 * often the chain fell through to the next supplier or all the way to seed.
 *
 * Deliberately in-memory: a new table means a migration, and telemetry must never be
 * able to fail a customer search. Counters are per-instance - the same best-effort
 * posture as the live budget - but failures are ALSO echoed through console.warn so
 * they reach the platform logs even on a cold instance that only lives for seconds.
 */
import { warnAndPage } from "./alerts";

export type ProviderCall = {
  /** Supplier's own id, e.g. "Google Flights" / "Ignav". */
  provider: string;
  /** Epoch ms when the call finished. */
  at: number;
  /** Wall-clock duration of OUR request, measured in flight-data.ts. */
  ms: number;
  /** The supplier's own reported latency, when it sends one (Scrappa does). */
  upstreamMs?: number;
  ok: boolean;
  /** HTTP status, or null when the request never got an answer (timeout/network). */
  status: number | null;
  /**
   * Coarse bucket the report counts. Chosen so the exact failures the quota audit
   * asked about - 402, 429, 503, timeout, empty - are each their own counter rather
   * than being folded into "failed".
   */
  reason: "ok" | "402" | "429" | "5xx" | "http" | "timeout" | "network" | "empty";
  /** How many fares came back. 0 with reason "ok" would be a supplier bug. */
  offers: number;
};

export type FallThrough = {
  at: number;
  /** Provider that was abandoned. */
  from: string;
  /** "next-provider" = another supplier was tried; "seed" = whole chain gave up. */
  to: "next-provider" | "seed";
  purpose: string;
};

const MAX_ENTRIES = 300;

const calls: ProviderCall[] = [];
const fallThroughs: FallThrough[] = [];

export function recordProviderCall(entry: Omit<ProviderCall, "at"> & { at?: number }): void {
  calls.push({ at: entry.at ?? Date.now(), ...entry } as ProviderCall);
  if (calls.length > MAX_ENTRIES) calls.shift();
  if (!entry.ok) {
    // The failures are the entire point of this module. Echo them so they survive
    // an instance that dies before anyone reads the buffer.
    warnAndPage("provider:failure",
      "[provider]",
      entry.provider,
      `status=${entry.status ?? "-"}`,
      `reason=${entry.reason}`,
      `${entry.ms}ms`,
      `offers=${entry.offers}`,
    );
  }
}

export function recordFallThrough(from: string, to: FallThrough["to"], purpose: string): void {
  fallThroughs.push({ at: Date.now(), from, to, purpose });
  if (fallThroughs.length > MAX_ENTRIES) fallThroughs.shift();
}

export type ProviderStat = {
  provider: string;
  calls: number;
  ok: number;
  failed: number;
  /** Keyed by ProviderCall.reason - "402", "429", "5xx", "timeout", "empty", ... */
  byReason: Record<string, number>;
  /** Median of all measured durations, null when nothing was measured. */
  medianMs: number | null;
  worstMs: number | null;
  /** Median of the supplier's own reported latency, when it provides one. */
  medianUpstreamMs: number | null;
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

export function providerCallStats(): ProviderStat[] {
  const byProvider = new Map<string, ProviderCall[]>();
  for (const call of calls) {
    const bucket = byProvider.get(call.provider) ?? [];
    bucket.push(call);
    byProvider.set(call.provider, bucket);
  }

  return Array.from(byProvider.entries()).map(([provider, rows]) => {
    const byReason: Record<string, number> = {};
    for (const row of rows) byReason[row.reason] = (byReason[row.reason] ?? 0) + 1;
    const durations = rows.map(row => row.ms);
    const upstream = rows.filter(row => typeof row.upstreamMs === "number").map(row => row.upstreamMs as number);
    const okCount = rows.filter(row => row.ok).length;
    return {
      provider,
      calls: rows.length,
      ok: okCount,
      failed: rows.length - okCount,
      byReason,
      medianMs: median(durations),
      worstMs: durations.length ? Math.max(...durations) : null,
      medianUpstreamMs: median(upstream),
    };
  });
}

export function fallThroughStats(): {
  toNextProvider: number;
  toSeed: number;
  byProvider: Record<string, number>;
} {
  const byProvider: Record<string, number> = {};
  let toNextProvider = 0;
  let toSeed = 0;
  for (const row of fallThroughs) {
    if (row.to === "seed") toSeed += 1;
    else toNextProvider += 1;
    byProvider[row.from] = (byProvider[row.from] ?? 0) + 1;
  }
  return { toNextProvider, toSeed, byProvider };
}

export function recentProviderCalls(limit = MAX_ENTRIES): ProviderCall[] {
  return calls.slice(-limit);
}

/** Test-only: buffers are module state and would otherwise leak between cases. */
export function resetProviderTelemetry(): void {
  calls.length = 0;
  fallThroughs.length = 0;
}

/** Buckets a non-2xx status into the counter the report reads. */
export function httpReason(status: number): ProviderCall["reason"] {
  if (status === 402) return "402"; // out of credits - the one that must never be silent
  if (status === 429) return "429";
  if (status >= 500) return "5xx";
  return "http";
}

/** Buckets a thrown fetch error. AbortSignal.timeout surfaces as TimeoutError. */
export function thrownReason(error: unknown): ProviderCall["reason"] {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "timeout";
  }
  return "network";
}
