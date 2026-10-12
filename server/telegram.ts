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

/**
 * @param recipientChatId Optional Telegram chat to deliver to. When supplied, the
 *   message goes to THAT chat - a customer's, captured at sign-up. When absent it
 *   falls back to TELEGRAM_CHAT_ID, the owner's chat, which is what every alert did
 *   before this parameter existed. The fallback is deliberate: an owner alert must
 *   keep working even when the customer never linked Telegram.
 *
 * A bot can only message a chat that has already started a conversation with it, so
 * a customer-supplied id that has never pressed Start fails with a 403. That is
 * reported as delivered:false with the reason, never as success.
 */
export async function deliverTelegram(message: string, recipientChatId?: string | null): Promise<NotificationResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = (recipientChatId && recipientChatId.trim()) || process.env.TELEGRAM_CHAT_ID;
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

/**
 * The bot's PUBLIC username, for building a t.me link the customer can tap.
 *
 * A bot can only message a chat that has already started a conversation with it,
 * so the sign-up page has to send the customer to the bot and have them press
 * Start - otherwise their stored chat id produces a 403 and the alert cannot
 * reach them. That instruction is useless without a link.
 *
 * The username is derived here rather than hardcoded because it is the SERVER's
 * credential that identifies the bot, not the browser's: getMe is called with the
 * token this process already holds, and only the PUBLIC username field comes back.
 * The token is never sent to the client and never returned. A hardcoded name would
 * silently break if the bot were ever renamed.
 *
 * Cached in-module. A cold serverless instance pays one getMe call; every later
 * sign-up page view on that instance is free. A failure returns null rather than
 * throwing - a missing link degrades the sign-up copy, it must never break the
 * page that is trying to create an account.
 */
let botUsernameCache: string | null | undefined;

export async function getTelegramBotUsername(): Promise<string | null> {
  if (botUsernameCache !== undefined) return botUsernameCache;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    botUsernameCache = null;
    return null;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(5_000) : undefined,
    });
    if (!res.ok) {
      botUsernameCache = null;
      return null;
    }
    const body = (await res.json()) as { ok?: boolean; result?: { username?: string } };
    // Only the public username leaves this function. The token that got us here
    // stays inside this process.
    const username = typeof body?.result?.username === "string" ? body.result.username.trim() : "";
    botUsernameCache = username || null;
    return botUsernameCache;
  } catch {
    botUsernameCache = null;
    return null;
  }
}
