import { bounded } from "./quota";

/**
 * Vercel's deployment counter, read from Vercel itself.
 *
 * The quota board already watched four ceilings it could not read; deployments was
 * the one that had no business staying blind, because the deployments API is free on
 * every plan (unlike /v1/usage, which answers plan_upgrade_required on Hobby - that
 * paywall is why Fast Data Transfer stays a blind row while this one does not).
 *
 * What is counted: deployments whose createdAt falls inside the rolling 24 hours
 * before `at`. That window is not a choice - Vercel's published Hobby limit is
 * "100 Deployments Created per Day", enforced as 100 per rolling 86400 seconds
 * (vercel.com/docs/limits), so the window is the limit's own window and the percent
 * on the board means the same thing Vercel means by it.
 *
 * Failure contract (same as the render probe): never throws, never guesses. A missing
 * token, a rejected fetch, or an unparsable body all come back as used = null with a
 * reason for the row to show - never as 0, which would read as "no deployments made"
 * during the very outage that hid the count.
 */

export type VercelUsageReading = {
  /** Deployments in the rolling window, or null when no honest count exists. */
  used: number | null;
  /** Why the number is missing. null when the read succeeded. */
  reason: string | null;
};

// Public identifiers (they appear in dashboard URLs), not secrets. The token itself
// comes from the VERCEL_TOKEN env var this project's function already carries.
const PROJECT_ID = "prj_z2IcsLAbUsusY1xtw2V1e23ONiP0";
const TEAM_ID = "team_m4mVtvx8gY21fFlLgpZseBGH";
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

type DeploymentListItem = { createdAt?: unknown };

/**
 * Pure: deployments inside the window, so the counting rule is unit-testable without
 * touching the network. A non-number createdAt is ignored - it can neither join the
 * count nor be assumed into it.
 */
export function countDeploymentsSince(deployments: DeploymentListItem[], sinceMs: number): number {
  let count = 0;
  for (const item of deployments) {
    if (typeof item.createdAt === "number" && item.createdAt >= sinceMs) count += 1;
  }
  return count;
}

export async function measureVercelDeployments(at: Date = new Date()): Promise<VercelUsageReading> {
  const token = (process.env.VERCEL_TOKEN || "").trim();
  if (!token) {
    return {
      used: null,
      reason: "Vercel API token not configured (VERCEL_TOKEN) - the count is withheld, never assumed.",
    };
  }
  const url =
    `https://api.vercel.com/v6/deployments?projectId=${PROJECT_ID}&teamId=${TEAM_ID}&limit=100`;
  // bounded() gives this the same 4 s ceiling and null-on-timeout behaviour as every
  // other board source, so a hanging Vercel API costs this row its number and the
  // board still renders inside the function time limit.
  const body = await bounded(async () => {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`vercel deployments HTTP ${res.status}`);
    return (await res.json()) as { deployments?: DeploymentListItem[] };
  });
  if (!body || !Array.isArray(body.deployments)) {
    return {
      used: null,
      reason: "Vercel deployments API did not answer at read time - the count is withheld, never assumed.",
    };
  }
  return { used: countDeploymentsSince(body.deployments, at.getTime() - ROLLING_WINDOW_MS), reason: null };
}
