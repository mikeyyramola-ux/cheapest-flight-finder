import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The Render probe is the quota board's only live wire into the primary engine, so
 * its failure modes are the board's failure modes. What is asserted here:
 *
 *  - a reading is the engine's own ledger age, in whole minutes, parsed as UTC;
 *  - EVERY failure path returns used: null with a stated reason. The probe may say
 *    "I do not know" to the board, but it may never say "0 minutes fresh" while the
 *    truth is unreachable - that is the false-green rule from cloud-quota.ts applied
 *    to its newest feed;
 *  - it never rejects: a dead Render must degrade one row, never the whole board.
 */

import { probeRenderEngine } from "./render-probe";

const AT = new Date("2026-09-30T06:00:00Z");

function stubFetch(handler: (init?: RequestInit) => Promise<Response>) {
  const spy = vi.fn((_url: unknown, init?: RequestInit) => handler(init));
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the Render engine probe", () => {
  it("returns the ledger age in whole minutes", async () => {
    stubFetch(async () => new Response(JSON.stringify({ ok: true, updated: "2026-09-30 05:30:00" }), { status: 200 }));
    const probe = await probeRenderEngine(AT);
    expect(probe.used).toBe(30);
    expect(probe.reason).toBeNull();
  });

  it("clamps clock skew to zero instead of reporting a negative age", async () => {
    stubFetch(async () => new Response(JSON.stringify({ updated: "2026-09-30 06:05:00" }), { status: 200 }));
    const probe = await probeRenderEngine(AT);
    expect(probe.used).toBe(0);
    expect(probe.reason).toBeNull();
  });

  it("withholds the number when the engine answers HTTP 500", async () => {
    stubFetch(async () => new Response("boom", { status: 500 }));
    const probe = await probeRenderEngine(AT);
    expect(probe.used).toBeNull();
    expect(probe.reason).toMatch(/HTTP 500/);
    expect(probe.reason).toMatch(/withheld, never assumed/);
  });

  it("withholds the number when the answer is not JSON", async () => {
    stubFetch(async () => new Response("<html>captive portal</html>", { status: 200 }));
    const probe = await probeRenderEngine(AT);
    expect(probe.used).toBeNull();
    expect(probe.reason).toMatch(/unparseable answer/);
  });

  it("withholds the number when there is no ledger timestamp to read", async () => {
    stubFetch(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const probe = await probeRenderEngine(AT);
    expect(probe.used).toBeNull();
    expect(probe.reason).toMatch(/no ledger timestamp/);
  });

  it("withholds the number when the fetch itself dies", async () => {
    stubFetch(() => Promise.reject(new Error("connection refused")));
    const probe = await probeRenderEngine(AT);
    expect(probe.used).toBeNull();
    expect(probe.reason).toMatch(/connection refused/);
  });

  it("gives up rather than holding the board behind a spinning-up instance", async () => {
    vi.stubEnv("RENDER_PROBE_TIMEOUT_MS", "40");
    // A free instance takes ~60 s to wake: the probe must abort, return no number,
    // and resolve rather than reject - a hanging engine cannot hang the board.
    stubFetch(
      init =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    const probe = await probeRenderEngine(AT);
    expect(probe.used).toBeNull();
    expect(probe.reason).toMatch(/timeout after 40 ms/);
  });

  it("asks for the configured endpoint, not a hard-coded copy of it", async () => {
    vi.stubEnv("RENDER_STATE_URL", "https://example.test/api/state");
    const spy = stubFetch(async () => new Response(JSON.stringify({ updated: "2026-09-30 06:00:00" }), { status: 200 }));
    await probeRenderEngine(AT);
    expect(spy).toHaveBeenCalledWith("https://example.test/api/state", expect.anything());
  });
});
