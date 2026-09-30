import { describe, expect, it } from "vitest";
import { countDeploymentsSince } from "./vercel-usage";

/**
 * The counting rule behind the deployments row. It is pure on purpose: the network
 * call around it is the same bounded-fetch pattern the board uses everywhere, while
 * the decision "does this deployment count" is the part that can silently lie - a
 * window measured from the wrong end would report capacity that is already spent.
 */

describe("countDeploymentsSince", () => {
  const windowStart = 1_790_726_400_000; // an arbitrary but fixed rolling-window start

  it("counts only deployments created at or after the window start", () => {
    const count = countDeploymentsSince(
      [
        { createdAt: windowStart - 1 }, // just outside: an older deploy
        { createdAt: windowStart }, // boundary belongs to the window
        { createdAt: windowStart + 60_000 },
      ],
      windowStart,
    );
    expect(count).toBe(2);
  });

  it("returns a genuine zero when nothing was deployed inside the window", () => {
    expect(countDeploymentsSince([{ createdAt: windowStart - 5 }], windowStart)).toBe(0);
  });

  it("never counts an item whose createdAt is not a number", () => {
    // A malformed API row must not be assumed into the count: it could be an old
    // deployment, a future one, or a shape change we have not seen before.
    const count = countDeploymentsSince([{ createdAt: "soon" }, {}, { createdAt: null }], windowStart);
    expect(count).toBe(0);
  });

  it("stays correct when the API hands back the full page", () => {
    // Vercel caps the Hobby plan at 100 deployments per rolling day, so a full
    // 100-item page is exactly the saturating case: every one of them in-window
    // must read 100/100, not 99 or 101.
    const full = Array.from({ length: 100 }, () => ({ createdAt: windowStart + 1 }));
    expect(countDeploymentsSince(full, windowStart)).toBe(100);
  });
});
