import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The bot-username lookup exists so the sign-up page can link a customer to the
 * bot and have them press Start - which Telegram requires before it will deliver
 * anything to them.
 *
 * It is the one function in this change that holds a secret and returns a value,
 * so the property that matters most is negative: the TOKEN must never leave.
 * A test that only checked "returns a username" would pass just as happily against
 * a version that returned the whole API response.
 */

const TOKEN = "7123456789:AAH-secret-token-that-must-never-leak";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadFresh() {
  // Fresh module each time: the lookup caches its result in-module, so reusing the
  // import would let one test's cache answer for the next.
  vi.resetModules();
  return await import("./telegram");
}

function stubGetMe(username?: string, ok = true) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 401,
    json: async () =>
      ok
        ? { ok: true, result: { id: 7123456789, is_bot: true, first_name: "Fareloop", username } }
        : { ok: false, description: "Unauthorized" },
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("getTelegramBotUsername", () => {
  it("returns the bot's public username", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", TOKEN);
    stubGetMe("FareloopBot");

    const { getTelegramBotUsername } = await loadFresh();
    expect(await getTelegramBotUsername()).toBe("FareloopBot");
  });

  it("NEVER returns the token, in any shape", async () => {
    // The decisive check. Whatever comes back - string or null - the secret that
    // fetched it must not appear anywhere in the value or its serialised form.
    vi.stubEnv("TELEGRAM_BOT_TOKEN", TOKEN);
    stubGetMe("FareloopBot");

    const { getTelegramBotUsername } = await loadFresh();
    const result = await getTelegramBotUsername();

    expect(result).not.toContain(TOKEN);
    expect(result).not.toContain("AAH");
    expect(result).not.toContain("7123456789");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("asks Telegram with the token but returns only the username field", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", TOKEN);
    const fetchMock = stubGetMe("FareloopBot");

    const { getTelegramBotUsername } = await loadFresh();
    await getTelegramBotUsername();

    // The token IS used to make the call - that is the point of it being server-side.
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain(`/bot${TOKEN}/getMe`);

    // And what comes back is a bare string, not the response body.
    const result = await getTelegramBotUsername();
    expect(typeof result).toBe("string");
    expect(result).not.toHaveProperty("result");
  });

  it("caches, so repeated sign-up views cost one getMe call", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", TOKEN);
    const fetchMock = stubGetMe("FareloopBot");

    const { getTelegramBotUsername } = await loadFresh();
    await getTelegramBotUsername();
    await getTelegramBotUsername();
    await getTelegramBotUsername();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when Telegram rejects the token, rather than throwing", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", TOKEN);
    stubGetMe(undefined, false);

    const { getTelegramBotUsername } = await loadFresh();
    expect(await getTelegramBotUsername()).toBeNull();
  });

  it("returns null when the response carries no username", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", TOKEN);
    stubGetMe("");

    const { getTelegramBotUsername } = await loadFresh();
    expect(await getTelegramBotUsername()).toBeNull();
  });

  it("returns null rather than throwing when the network fails", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", TOKEN);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const { getTelegramBotUsername } = await loadFresh();
    // A missing link degrades the sign-up copy; it must never break the page.
    expect(await getTelegramBotUsername()).toBeNull();
  });

  it("returns null when no token is configured, and makes no request", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const fetchMock = stubGetMe("FareloopBot");

    const { getTelegramBotUsername } = await loadFresh();
    expect(await getTelegramBotUsername()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
