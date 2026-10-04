/**
 * Per-IP caps for the endpoints that spend supplier credits or fire notifications.
 *
 * Two windows, because they stop two different attacks:
 *   - minute  20/min  stops a burst (one bot hammering a single endpoint)
 *   - day     opt-in  stops a slow drip spread across hours
 *
 * In-memory and therefore per-instance - the same best-effort posture as the live
 * budget in flight-data.ts. A globally true count needs shared storage, which is
 * spend and needs its own proposal.
 */
export const RATE_LIMIT_MAX = 20;
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const DAILY_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Anonymous search: 10 requests/day/IP = at most 5 round-trip searches. */
export const DAILY_SEARCH_LIMIT = 10;

const MAX_BUCKETS = 10_000;

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

/** Returns true when the request is ALLOWED. */
export function hitRateLimit(
  key: string,
  max = RATE_LIMIT_MAX,
  windowMs = RATE_LIMIT_WINDOW_MS,
): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    // Fixed window with oldest-first eviction: a scanner must never grow this map
    // past a bound, or the defence becomes the memory leak.
    if (buckets.size > MAX_BUCKETS) buckets.delete(buckets.keys().next().value as string);
    return true;
  }
  bucket.count += 1;
  return bucket.count <= max;
}

/**
 * First hop of x-forwarded-for. Vercel sets it; req.ip alone resolves to the proxy.
 *
 * `headers` is optional: the router can be called directly with a minimal context
 * (no HTTP request at all), and a missing header must never become an exception that
 * masks the procedure's real answer.
 */
export function clientIp(
  headers?: Record<string, string | string[] | undefined>,
  fallback?: string,
): string {
  const fwd = headers?.["x-forwarded-for"];
  const raw = (Array.isArray(fwd) ? fwd[0] : fwd) || fallback || "unknown";
  return raw.split(",")[0].trim() || "unknown";
}
