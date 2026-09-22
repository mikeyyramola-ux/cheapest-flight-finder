import { expect, test, type Page } from "@playwright/test";

/**
 * UI feel QA: page-to-page transitions, scroll performance, and button latency.
 * Run against production with:
 *   TEST_BASE_URL=https://cheapest-flight-finder.vercel.app TEST_SKIP_SERVER=1 npx playwright test tests/e2e/ui-transitions.spec.ts
 */

// Screencast video recording throttles rAF (it drives a virtual display),
// which would corrupt frame-timing measurements — disable it for this file.
test.use({ video: "off" });
// Timing measurements must not race other workers for CPU: run this file's
// tests one at a time (still parallel with other spec FILES, so prefer
// --workers=1 when running the whole suite for benchmark-grade numbers).
test.describe.configure({ mode: "serial" });

type FrameSample = { t: number; o: number; path: string; sy: number; anims: number };

async function measureNavigation(page: Page, from: "/" | "/faq", toLink: { href: string; text: RegExp }) {
  return page.evaluate(
    async ({ from, href, text }) => {
      if (location.pathname !== from) throw new Error(`expected to start on ${from}, got ${location.pathname}`);
      const link = [...document.querySelectorAll("a")].find(
        a => a.getAttribute("href") === href && new RegExp(text, "i").test(a.textContent || ""),
      );
      if (!link) throw new Error(`nav link ${href} not found`);
      await page_scroll_mid();
      const frames: FrameSample[] = [];
      const t0 = performance.now();
      let settleAt: number | null = null;
      let sawAnimation = false;
      await new Promise<void>(resolve => {
        const step = () => {
          const shell = document.querySelector(".app-shell");
          const w = shell ? shell.parentElement : null;
          const o = w ? Number(getComputedStyle(w).opacity) : 0;
          const sy = Math.round(window.scrollY);
          const path = location.pathname;
          const anims = typeof document.getAnimations === "function" ? document.getAnimations().length : 0;
          const t = Math.round(performance.now() - t0);
          frames.push({ t, o: Number(o.toFixed(3)), path, sy, anims });
          if (anims > 0 || (w && o < 0.995)) sawAnimation = true;
          const targetPath = href.split("?")[0];
          if (settleAt === null && path === targetPath && w && o >= 0.99 && sy === 0) settleAt = t;
          if ((settleAt !== null && t - settleAt > 80) || t > 3000) return resolve();
          requestAnimationFrame(step);
        };
        link.click();
        requestAnimationFrame(step);
      });
      return { settleAt, sawAnimation, finalPath: location.pathname, finalScrollY: window.scrollY, frameCount: frames.length, maxAnims: Math.max(...frames.map(f => f.anims), 0), firstFrames: frames.slice(0, 3), lastFrame: frames[frames.length - 1] };

      async function page_scroll_mid() {
        // Start mid-page so we can prove the transition resets scroll to top.
        window.scrollTo(0, Math.min(1500, Math.max(0, document.documentElement.scrollHeight / 3)));
        await new Promise(r => requestAnimationFrame(r));
      }
    },
    { from, href: toLink.href, text: toLink.text.source },
  );
}

test.describe("page transitions and UI feel", () => {
  test("Home -> FAQ animates, settles fast, and lands at top", async ({ page }, testInfo) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const r = await measureNavigation(page, "/", { href: "/faq", text: "cheap flights FAQ" });
    testInfo.attach("nav-home-to-faq", { body: JSON.stringify(r, null, 2), contentType: "application/json" });
    expect(r.sawAnimation, "exit/enter animation frames should be observable").toBe(true);
    expect(r.settleAt, "should settle on /faq at scroll 0").not.toBeNull();
    expect(r.settleAt!).toBeLessThan(900);
    expect(r.finalPath).toBe("/faq");
    expect(r.finalScrollY).toBe(0);
  });

  test("FAQ -> Home (CTA) animates, settles fast, and lands at top", async ({ page }, testInfo) => {
    await page.goto("/faq", { waitUntil: "domcontentloaded" });
    const r = await measureNavigation(page, "/faq", { href: "/", text: "search flights" });
    testInfo.attach("nav-faq-to-home", { body: JSON.stringify(r, null, 2), contentType: "application/json" });
    expect(r.sawAnimation).toBe(true);
    expect(r.settleAt, "should settle on / at scroll 0").not.toBeNull();
    expect(r.settleAt!).toBeLessThan(900);
    expect(r.finalPath).toBe("/");
    expect(r.finalScrollY).toBe(0);
  });

  test("scrolling down and up stays smooth (frame timing vs idle baseline)", async ({ page }, testInfo) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    // Let hydration/auto-search settle first — measuring during initial load
    // would attribute startup work to scrolling itself.
    await page.waitForTimeout(1200);
    const perf = await page.evaluate(async () => {
      const stats = (d: number[]) => {
        const body = d.slice(1);
        const sorted = [...body].sort((a, b) => a - b);
        const avg = body.reduce((s, v) => s + v, 0) / Math.max(1, body.length);
        return {
          frames: body.length,
          avgMs: Number(avg.toFixed(2)),
          p95Ms: Number((sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(1)),
          maxMs: Number((sorted[sorted.length - 1] ?? 0).toFixed(1)),
          approxFps: Number((1000 / avg).toFixed(1)),
        };
      };
      const run = async (mode: "idle" | "down" | "up") => {
        const ms = mode === "idle" ? 800 : 1100;
        const deltas: number[] = [];
        let direction = mode === "up" ? -1 : 1;
        const start = performance.now();
        let last = start;
        await new Promise<void>(resolve => {
          const step = () => {
            const now = performance.now();
            deltas.push(now - last);
            last = now;
            if (mode !== "idle") {
              window.scrollBy(0, 90 * direction);
              // "down" wraps at the bottom; "up" rides to the top and rests there.
              if (mode === "down" && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1) direction = -1;
            }
            // "idle"/"down" run for a fixed duration; "up" finishes only when
            // it actually reaches the top (frame rate varies, so a fixed
            // duration could run out of travel before arriving).
            if (mode !== "up" && now - start >= ms) return resolve();
            if (mode === "up" && window.scrollY <= 0 && now - start > 100) return resolve();
            if (now - start >= 4000) return resolve();
            requestAnimationFrame(step);
          };
          step();
        });
        return stats(deltas);
      };
      window.scrollTo(0, 0);
      await new Promise(r => requestAnimationFrame(r));
      // Idle = this machine's rendering ceiling (headless software rendering can
      // be well under 60fps). Scrolling is judged RELATIVE to that ceiling.
      const idle = await run("idle");
      const scrollDown = await run("down");
      const scrollUp = await run("up");
      return { idle, scrollDown, scrollUp, endedAtTop: window.scrollY === 0 };
    });
    testInfo.attach("scroll-performance", { body: JSON.stringify(perf, null, 2), contentType: "application/json" });
    console.log("SCROLL_PERF " + JSON.stringify(perf));
    expect(perf.scrollDown.frames, "should sample frames while scrolling").toBeGreaterThan(20);
    expect(perf.scrollDown.avgMs, `scroll avg ${perf.scrollDown.avgMs}ms (idle ceiling ${perf.idle.avgMs}ms)`).toBeLessThan(70);
    expect(
      perf.scrollDown.avgMs,
      `scrolling must not cost far more than idle: ${perf.scrollDown.avgMs}ms vs idle ${perf.idle.avgMs}ms`,
    ).toBeLessThan(Math.max(perf.idle.avgMs * 2.5, 55));
    expect(perf.scrollUp.avgMs, `scroll-up avg ${perf.scrollUp.avgMs}ms`).toBeLessThan(70);
    expect(perf.endedAtTop, "scroll-up should return to the top").toBe(true);
  });

  test("search, sort, and traveler buttons respond fast and recalculate", async ({ page }, testInfo) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    // Measured entirely in-page (click + rAF poll) so Playwright's own
    // actionability polling doesn't pollute the numbers.
    const timings = await page.evaluate(async () => {
      const out: Record<string, number | string> = {};
      const waitPred = (pred: () => boolean, timeout = 6000) =>
        new Promise<boolean>(resolve => {
          const t0 = performance.now();
          const step = () => {
            if (pred()) return resolve(true);
            if (performance.now() - t0 > timeout) return resolve(false);
            requestAnimationFrame(step);
          };
          step();
        });
      const btn = (label: string) =>
        [...document.querySelectorAll("button")].find(b => (b.textContent || "").trim() === label) as HTMLButtonElement | undefined;
      const firstPrice = () => document.querySelector(".flight-price")?.textContent || "";
      const firstDuration = () => document.querySelector(".route-duration")?.textContent || "";
      const searchResponseAfter = (t0: number) => () =>
        performance
          .getEntriesByType("resource")
          .some(r => r.name.includes("trpc") && r.name.toLowerCase().includes("search") && r.startTime >= t0 - 5 && r.responseEnd > 0);

      // Search -> tRPC round-trip completes
      let t0 = performance.now();
      const searchBtn = [...document.querySelectorAll("button")].find(b => /search fares/i.test(b.textContent || "")) as HTMLButtonElement;
      searchBtn.click();
      out.searchToResultsMs = (await waitPred(searchResponseAfter(t0))) ? Math.round(performance.now() - t0) : "timeout";

      // Sort fastest (pure client-side render)
      t0 = performance.now();
      btn("Fastest")?.click();
      out.sortFastestMs = (await waitPred(() => firstDuration() === "6h 50m")) ? Math.round(performance.now() - t0) : "timeout";

      // Sort cheapest (pure client-side render)
      t0 = performance.now();
      btn("Cheapest total")?.click();
      out.sortCheapestMs = (await waitPred(() => firstPrice() === "389")) ? Math.round(performance.now() - t0) : "timeout";

      // Travelers -> totals recalculate (389 x 3 = 1,167), then re-search
      t0 = performance.now();
      const sel = [...document.querySelectorAll("select")].find(
        s => s.getAttribute("aria-label") === "Travelers" || /traveler/i.test(s.labels?.[0]?.textContent || ""),
      ) as HTMLSelectElement | undefined;
      if (sel) {
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
        setter?.call(sel, "3");
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
      searchBtn.click();
      out.travelerRecalcMs = (await waitPred(() => firstPrice() === "1,167" && searchResponseAfter(t0)())) ? Math.round(performance.now() - t0) : "timeout";

      return out;
    });
    testInfo.attach("button-timings", { body: JSON.stringify(timings, null, 2), contentType: "application/json" });
    console.log("BUTTON_TIMINGS " + JSON.stringify(timings));
    expect(timings.searchToResultsMs, `search: ${JSON.stringify(timings)}`).not.toBe("timeout");
    expect(timings.sortFastestMs, `sort fastest: ${JSON.stringify(timings)}`).not.toBe("timeout");
    expect(timings.sortCheapestMs, `sort cheapest: ${JSON.stringify(timings)}`).not.toBe("timeout");
    expect(timings.travelerRecalcMs, `traveler recalc: ${JSON.stringify(timings)}`).not.toBe("timeout");
    expect(timings.searchToResultsMs as number).toBeLessThan(2500);
    expect(timings.sortFastestMs as number).toBeLessThan(600);
    expect(timings.sortCheapestMs as number).toBeLessThan(600);
    expect(timings.travelerRecalcMs as number).toBeLessThan(3500);
  });

  test("no uncaught page errors during navigation", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", err => errors.push(String(err)));
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator('a[href="/faq"]').first().click();
    await expect(page.locator("h1").first()).toContainText("FAQ", { timeout: 5000 });
    await page.locator('a.primary-cta[href="/"]').first().click();
    await expect(page.locator(".app-shell").first()).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(700);
    expect(errors, `uncaught errors: ${errors.join(" | ")}`).toEqual([]);
  });
});
