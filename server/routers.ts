import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { adminProcedure, publicProcedure, router } from "./_core/trpc";
import { addTrackedRoute, ensureHistoryLoaded, ensureRoutesHydrated, getRouteHistory, getSeedHistory, listTrackedRoutes, removeTrackedRoute, scanTrackedRoutes, searchFlights, sendPriceDropNotification } from "./flight-data";
import { createPremiumCheckout, premiumPlan } from "./stripe";
import { createPayPalCheckout, getPayPalSubscription, handlePayPalWebhook, premiumPlanPayPal } from "./paypal";
import { getPartnerHealthReport } from "./partner-health";

const searchInput = z.object({
  origin: z.string().min(3).max(3),
  destination: z.string().min(3).max(3),
  departureDate: z.string(),
  returnDate: z.string().optional(),
  passengers: z.number().int().min(1).max(9),
  tripType: z.enum(["roundTrip", "oneWay"]).optional(),
});

/**
 * The premium gate, enforced on the SERVER and without a database: the caller
 * presents a PayPal subscription id and we ask PayPal itself whether it is ACTIVE.
 * Anything else - no id, malformed id, unapproved, cancelled, or a verification
 * that could not be completed - fails closed.
 *
 * Results are cached briefly so a burst of requests cannot hammer PayPal's API
 * on our credentials.
 *
 * Known limitation, lifted the moment a user store exists: an active id is not
 * yet bound to a specific person, so anyone who obtains one could replay it.
 */
const premiumCheckCache = new Map<string, { active: boolean; expiresAt: number }>();
const PREMIUM_CACHE_MS = 5 * 60 * 1000;

async function isActiveSubscriber(subscriptionId?: string): Promise<boolean> {
  if (!subscriptionId) return false;
  const cached = premiumCheckCache.get(subscriptionId);
  if (cached && Date.now() < cached.expiresAt) return cached.active;
  let active = false;
  try {
    const sub = (await getPayPalSubscription(subscriptionId)) as { status?: string };
    active = String(sub.status ?? "").toUpperCase() === "ACTIVE";
  } catch {
    active = false; // fail closed: an error is never treated as authorised
  }
  if (premiumCheckCache.size > 200) premiumCheckCache.clear();
  premiumCheckCache.set(subscriptionId, { active, expiresAt: Date.now() + PREMIUM_CACHE_MS });
  return active;
}

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  flights: router({
    search: publicProcedure.input(searchInput).mutation(async ({ input }) => searchFlights(input)),
    history: publicProcedure.input(z.object({ origin: z.string(), destination: z.string() })).query(async ({ input }) => {
      // Awaited so the answer reflects stored readings when they exist. Skipping this
      // would serve the seed series simply because the read happened before the load.
      await ensureHistoryLoaded(input.origin, input.destination);
      const history = getRouteHistory(input.origin, input.destination);
      return { points: history.points, source: history.source, windowDays: history.windowDays, gated: false as const };
    }),
  }),
  tracker: router({
    list: publicProcedure.query(async () => {
      // Restored from storage first: without this a freshly-started instance would
      // hand back its demo routes as though they were the customer's saved ones.
      await ensureRoutesHydrated();
      // No `plan` field here on purpose: this is a publicProcedure with no user
      // context, so any plan value it returned would be invented rather than known.
      return { routes: listTrackedRoutes() };
    }),
    add: publicProcedure
      .input(z.object({ origin: z.string().min(3), destination: z.string().min(3), departDate: z.string(), returnDate: z.string(), targetPrice: z.number().min(1), alertChannel: z.enum(["Telegram", "WhatsApp"]), subscriptionId: z.string().max(64).optional() }))
      .mutation(async ({ input }) => {
        const { subscriptionId, ...route } = input;
        // Enforced here, not in the browser: the paywall is a server decision.
        if (!(await isActiveSubscriber(subscriptionId))) {
          throw new TRPCError({ code: "FORBIDDEN", message: "An active Premium subscription is required to track a route." });
        }
        const saved = await addTrackedRoute(route);
        return { route: saved, upgraded: true };
      }),
    remove: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => ({ success: await removeTrackedRoute(input.id) })),
    scan: publicProcedure.mutation(async () => {
      const result = await scanTrackedRoutes();
      const notifications = await Promise.all(result.alerts.filter(item => item.notified).map(item => sendPriceDropNotification(item.route, item.dropPercent)));
      return { ...result, notifications };
    }),
  }),
  billing: router({
    pricing: publicProcedure.query(() => premiumPlan),
    pricingPayPal: publicProcedure.query(() => premiumPlanPayPal),
    checkout: publicProcedure.input(z.object({ route: z.string().optional() })).mutation(async ({ ctx, input }) => createPremiumCheckout({ origin: input.route ?? "dashboard", userId: ctx.user?.id, email: ctx.user?.email, name: ctx.user?.name })),
    checkoutPayPal: publicProcedure.input(z.object({ route: z.string().optional() })).mutation(async ({ ctx, input }) => createPayPalCheckout({ origin: input.route ?? "dashboard", userId: ctx.user?.id, email: ctx.user?.email, name: ctx.user?.name })),
    /**
     * Server-side premium verification, deliberately free of any database: we ask
     * PayPal itself whether the subscription is ACTIVE. Deliberately a mutation
     * (POST) so no CDN can ever cache an authorisation decision.
     */
    verifyPayPal: publicProcedure
      .input(z.object({ subscriptionId: z.string().min(6).max(64) }))
      .mutation(async ({ input }) => {
        try {
          const sub = (await getPayPalSubscription(input.subscriptionId)) as { id?: string; status?: string };
          const status = String(sub.status ?? "").toUpperCase();
          // Fail closed: only an explicitly ACTIVE subscription grants premium.
          // APPROVAL_PENDING / CREATED / SUSPENDED / CANCELLED must not.
          const premium = status === "ACTIVE";
          return { premium, status, subscriptionId: String(sub.id ?? input.subscriptionId), checkedAt: new Date().toISOString(), reason: premium ? "active" : "not-active" };
        } catch (error) {
          // Classify without leaking PayPal/API internals to the client.
          const message = error instanceof Error ? error.message : String(error);
          const reason = message.includes("not configured") ? "paypal-not-configured"
            : message.includes("Malformed") ? "invalid-subscription-id"
            : "verification-unavailable";
          return { premium: false, status: "unverified", subscriptionId: input.subscriptionId, checkedAt: new Date().toISOString(), reason };
        }
      }),
  }),
  monitoring: router({
    partners: adminProcedure.query(() => getPartnerHealthReport()),
  }),
});

export type AppRouter = typeof appRouter;
