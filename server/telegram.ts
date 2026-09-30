/**
 * Telegram delivery, in exactly one place.
 *
 * Extracted from flight-data so a price drop and a quota escalation leave through the
 * same code: one place reads the credentials, one place decides what "delivered"
 * means, and a second alert path can never drift into claiming an acceptance Telegram
 * never gave (the rule NotificationResult already makes).
 *
 * Two honesty rules survive the move:
 *
 *  - `delivered` is true ONLY when Telegram's own response body says ok. A configured
 *    token, an HTTP 200, or a missing error are not success.
 *  - Every refusal carries its reason, because a caller that cannot tell "never
 *    tried" from "tried and rejected" cannot decide whether to try again.
 *
 * The request is bounded by a 10-second timeout: an alert channel that hangs is an
 * alert channel that eats the caller's whole time budget (the daily cron has 60 s and
 * other work to finish), and a bounded failure can be retried where a hang cannot.
 */

export interface NotificationResult {
  channel: "Telegram" | "WhatsApp";
  message: string;
  /** True ONLY when the provider actually accepted the message. It is never
   *  inferred from credentials being present - a config
   *  broken bot must not be able to report success. */
  delivered: boolean;
  reason: string;
}

export async function deliverTelegram(message: string): Promise<NotificationResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { channel: "Telegram", message, delivered: false, reason: "Telegram credentials not configured" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message }),
      signal: typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(10_000) : undefined,
    });
    if (!res.ok) return { channel: "Telegram", message, delivered: false, reason: `Telegram API responded ${res.status}` };
    const body = (await res.json()) as { ok?: boolean; description?: string };
    if (!body.ok) return { channel: "Telegram", message, delivered: false, reason: body.description || "Telegram rejected the message" };
    return { channel: "Telegram", message, delivered: true, reason: "accepted by Telegram" };
  } catch (error) {
    return { channel: "Telegram", message, delivered: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
