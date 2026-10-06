/**
 * The owner-visible channel for warnings that used to vanish into platform logs.
 * ASK 103 (Stage 2.2, RED 2).
 *
 * Two rules survive the move to this file:
 *
 *  - The console line is printed FIRST and unchanged: whatever a test or a log
 *    reader saw before this file existed, they still see. This helper only adds
 *    a page on top; it never replaces, rewords, or swallows the warning.
 *  - A page is attempted at most once per key per hour (PAGE_THROTTLE_MS), so a
 *    flapping dependency cannot flood the owner's Telegram chat. The throttle
 *    decision is a pure function and is tested without any network.
 *
 * Without TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID nothing is attempted at all:
 * no promise, no fetch, no extra log line - the console warning above is the
 * whole behaviour, which is exactly what tests and local dev expect.
 *
 * Delivery itself stays in server/telegram.ts: `delivered` is true only when
 * Telegram's own response says so, and a failed page is reported here with the
 * reason rather than being claimed a success.
 */

import { deliverTelegram } from "./telegram";

/** One page per key per hour. */
export const PAGE_THROTTLE_MS = 60 * 60 * 1000;

/** key -> epoch ms of the last page sent for that key. Module state by design. */
const lastPagedAt = new Map<string, number>();

/**
 * Pure throttle decision, exported for tests: page only when the key has not
 * been paged within `throttleMs`. The state map and clock are injectable so the
 * test never touches module state or real time.
 */
export function shouldPage(
  key: string,
  now: number,
  throttleMs: number = PAGE_THROTTLE_MS,
  seen: Map<string, number> = lastPagedAt
): boolean {
  const previous = seen.get(key);
  if (previous !== undefined && now - previous < throttleMs) return false;
  seen.set(key, now);
  return true;
}

/** Console args collapsed into one readable line: key first, then the original text. */
function pageText(key: string, args: unknown[]): string {
  const body = args
    .map(arg => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return arg.message;
      return String(arg);
    })
    .join(" ");
  return `[Fareloop warn] ${key}: ${body}`;
}

/**
 * Warn exactly as before (identical console call, identical arguments), then
 * page the owner on Telegram at most once per key per hour.
 *
 * `key` is a short stable label ("db:upsert-user") used for throttling and as
 * the first token of the paged line - it is the thing the owner quotes back.
 */
export function warnAndPage(key: string, ...args: unknown[]): void {
  console.warn(...args);

  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
  if (!shouldPage(key, Date.now())) return;

  void deliverTelegram(pageText(key, args)).then(result => {
    if (!result.delivered) {
      console.warn(`[alerts] page for ${key} not delivered: ${result.reason}`);
    }
  });
}
