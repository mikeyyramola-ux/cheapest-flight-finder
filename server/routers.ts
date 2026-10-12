import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { adminProcedure, publicProcedure, rateLimited, router } from "./_core/trpc";
import { DAILY_SEARCH_LIMIT, clientIp, hitRateLimit } from "./_core/rate-limit";
import { ONE_YEAR_MS } from "@shared/const";
import { sdk } from "./_core/sdk";
import { createPasswordUser, getUserByEmail, getUserByOpenId, upsertUser } from "./db";
import { assessPassword, deriveOpenId, hashPassword, normalizeEmail, verifyPassword } from "./password";
import { ENV } from "./_core/env";
import { addTrackedRoute, ensureHistoryLoaded, ensureRoutesHydrated, getRouteHistory, getSeedHistory, listTrackedRoutesForUser, removeTrackedRouteForUser, scanTrackedRoutes, searchFlights, sendPriceDropNotification } from "./flight-data";
import { createPremiumCheckout, premiumPlan } from "./stripe";
import { createPayPalCheckout, getPayPalSubscription, getPremiumPlanPayPalLive, handlePayPalWebhook } from "./paypal";
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
 * GO 167 - first-party account credentials.
 *
 * Email is bounded at 320 (the RFC 5321 ceiling, and the column's width) and
 * coerced to lowercase before storage, so `Ada@x.com` and `ada@x.com` are one
 * account rather than two competing subscriptions. Telegram chat id is optional
 * here: a customer may register before they have run /start on the bot, and
 * linking later must not require re-registering.
 */
const registerInput = z.object({
  email: z.string().trim().min(3).max(320).includes("@"),
  password: z.string().min(1).max(200),
  name: z.string().trim().max(120).optional(),
  telegramChatId: z.string().trim().max(64).optional(),
});

const loginInput = z.object({
  email: z.string().trim().min(3).max(320).includes("@"),
  password: z.string().min(1).max(200),
});

/**
 * Sessions are signed with JWT_SECRET. When it is absent, `jose` refuses to sign
 * with "Zero-length key is not supported" - a cryptic 500 that tells the customer
 * nothing and looks like a bug in login. Checking here turns it into a clear,
 * actionable answer instead. This is an environment problem, never a customer one,
 * so the message never blames their credentials.
 *
 * It also means the OAuth path could never have worked either: the same secret
 * signs those tokens. Worth stating plainly, because it is easy to believe auth
 * was configured when it was only ever half-wired.
 */
function assertSessionSecret() {
  if (!ENV.cookieSecret) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Sign-in is not configured on the server yet (JWT_SECRET is missing). This is not a problem with your account.",
    });
  }
}

/**
 * Rate caps for the two endpoints worth attacking.
 *
 * Login is the brute-force surface, so it is much tighter than the 20/min the
 * search paths use: 5 per minute per IP is generous for a human who mistyped a
 * password twice, and useless to a script. Registering is capped slightly higher
 * because a genuine signup flow may retry once or twice.
 */
const AUTH_RATE_MAX = 5;
const AUTH_RATE_WINDOW_MS = 60_000;

/**
 * The subset of a user that may leave the server.
 *
 * `passwordHash` must never cross this boundary, and neither should the raw
 * `openId` - it is the internal key, and exposing it invites the subscription
 * replay the rest of this change exists to close.
 */
function publicUser(user: { id: number; name: string | null; email: string | null; role: string; subscriptionStatus: string; telegramChatId: string | null; paypalSubscriptionId: string | null }) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    subscriptionStatus: user.subscriptionStatus,
    telegramChatId: user.telegramChatId,
    hasPaypalSubscription: Boolean(user.paypalSubscriptionId),
  };
}

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

    /**
     * GO 167 - first-party email/password registration.
     *
     * The platform OAuth server is not configured for Fareloop, so without this the
     * only identity a customer could have was a PayPal id sitting in localStorage -
     * lost on a new device, and replayable by anyone who saw it. This gives them an
     * account that is theirs.
     *
     * Deliberate properties:
     *  - Same session cookie and `ctx.user` as OAuth, so nothing downstream has to
     *    learn a second auth model. A password user simply has a row in `users`.
     *  - Identical error for "address taken" and "invalid password", so the endpoint
     *    cannot be used to enumerate which emails are registered.
     *  - Rate limited per IP: this is the one endpoint that is worth brute forcing.
     */
    register: publicProcedure
      .input(registerInput)
      .mutation(async ({ ctx, input }) => {
        assertSessionSecret();
        if (!hitRateLimit(`auth:register:${clientIp(ctx.req.headers)}`, AUTH_RATE_MAX, AUTH_RATE_WINDOW_MS)) {
          throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many attempts. Please wait a minute and try again." });
        }

        const email = normalizeEmail(input.email);
        const policy = assessPassword(input.password);
        if (!policy.ok) throw new TRPCError({ code: "BAD_REQUEST", message: policy.reason ?? "Invalid password." });

        // Cheap pre-check so the common case fails fast without a scrypt hash.
        // Security is still carried by the unique openId - this is UX, not the guard.
        const existing = await getUserByEmail(email);
        if (existing) throw new TRPCError({ code: "CONFLICT", message: "An account already exists for this email." });

        const passwordHash = await hashPassword(input.password);
        const openId = deriveOpenId(email);
        const created = await createPasswordUser({
          openId,
          email,
          name: input.name?.trim() || null,
          passwordHash,
          telegramChatId: input.telegramChatId?.trim() || null,
        });

        if (created.alreadyRegistered) throw new TRPCError({ code: "CONFLICT", message: "An account already exists for this email." });
        if (!created.ok) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not create the account. Please try again." });

        const user = await getUserByOpenId(openId);
        if (!user) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Account created but could not be loaded. Please sign in." });

        // Identical to the OAuth callback: one session cookie, one year, same name.
        // The email is the fallback name because it is what the customer actually
        // typed, and because createSessionToken refuses to sign an empty one.
        const sessionToken = await sdk.createSessionToken(openId, { name: user.name || user.email || openId, expiresInMs: ONE_YEAR_MS });
        ctx.res.cookie(COOKIE_NAME, sessionToken, { ...getSessionCookieOptions(ctx.req), maxAge: ONE_YEAR_MS });

        return { user: publicUser(user) };
      }),

    /** GO 167 - password login. Sets the same session cookie the OAuth flow sets. */
    login: publicProcedure
      .input(loginInput)
      .mutation(async ({ ctx, input }) => {
        assertSessionSecret();
        const ip = clientIp(ctx.req.headers);
        if (!hitRateLimit(`auth:login:${ip}`, AUTH_RATE_MAX, AUTH_RATE_WINDOW_MS)) {
          throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many attempts. Please wait a minute and try again." });
        }

        const email = normalizeEmail(input.email);
        const user = await getUserByEmail(email);
        // No user row: still run a hash so the two paths cost the same time and
        // "no such account" cannot be distinguished from "wrong password" by a clock.
        const stored = user?.passwordHash ?? null;
        const check = await verifyPassword(input.password, stored);

        if (!user || !check.ok) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "Incorrect email or password." });
        }

        const sessionToken = await sdk.createSessionToken(user.openId, { name: user.name || user.email || user.openId, expiresInMs: ONE_YEAR_MS });
        ctx.res.cookie(COOKIE_NAME, sessionToken, { ...getSessionCookieOptions(ctx.req), maxAge: ONE_YEAR_MS });
        await upsertUser({ openId: user.openId, lastSignedIn: new Date() });

        return { user: publicUser(user) };
      }),
  }),
  flights: router({
    // Variant B (owner decision, PROPOSAL 19): anonymous demo search stays alive, but
    // bounded to 20/min and DAILY_SEARCH_LIMIT per day per IP so a bot cannot drain the
    // shared Scrappa pool through the public path.
    search: publicProcedure
      .input(searchInput)
      .use(rateLimited({ perDay: DAILY_SEARCH_LIMIT }))
      .mutation(async ({ input }) => searchFlights(input)),
    history: publicProcedure.input(z.object({ origin: z.string(), destination: z.string() })).query(async ({ input }) => {
      // Awaited so the answer reflects stored readings when they exist. Skipping this
      // would serve the seed series simply because the read happened before the load.
      await ensureHistoryLoaded(input.origin, input.destination);
      const history = getRouteHistory(input.origin, input.destination);
      return { points: history.points, source: history.source, windowDays: history.windowDays, gated: false as const };
    }),
  }),
  tracker: router({
    /**
     * GO 167 - the watch list is now the caller's own, and nobody else's.
     *
     * Previously this returned `listTrackedRoutes()` unfiltered: one shared table,
     * one shared list. Every subscriber saw every other subscriber's routes, and -
     * because `remove` only asked "is this caller a subscriber?" - could also delete
     * them. Ownership is now derived from the session, never from the request body,
     * so a caller cannot name someone else's id any more than they can forge a row.
     *
     * Signed out returns an empty list rather than an error: the sidebar renders
     * this on every page load, and a 401 there would fill the console for visitors
     * who simply have not logged in yet.
     */
    list: publicProcedure.query(async ({ ctx }) => {
      await ensureRoutesHydrated();
      const userId = ctx.user?.id;
      if (!userId) return { routes: [], authenticated: false as const };
      return { routes: await listTrackedRoutesForUser(userId), authenticated: true as const };
    }),

    add: publicProcedure
      .input(z.object({ origin: z.string().min(3), destination: z.string().min(3), departDate: z.string(), returnDate: z.string(), targetPrice: z.number().min(1), alertChannel: z.enum(["Telegram", "WhatsApp"]), subscriptionId: z.string().max(64).optional() }))
      .use(rateLimited())
      .mutation(async ({ ctx, input }) => {
        const { subscriptionId, ...route } = input;

        // An account is required first. This is what makes ownership possible at
        // all: without a stable user id there is nobody to attach a route to.
        const userId = ctx.user?.id;
        if (!userId) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "Please sign in to track a route." });
        }

        // Enforced here, not in the browser: the paywall is a server decision.
        // The session's own subscription wins over a client-supplied id, because a
        // body parameter is whatever the caller felt like typing.
        const effectiveSubId = ctx.user?.paypalSubscriptionId ?? subscriptionId;
        if (!(await isActiveSubscriber(effectiveSubId))) {
          throw new TRPCError({ code: "FORBIDDEN", message: "An active Premium subscription is required to track a route." });
        }

        const saved = await addTrackedRoute({ ...route, userId });
        return { route: saved, upgraded: true };
      }),

    remove: publicProcedure
      .input(z.object({ id: z.string(), subscriptionId: z.string().max(64).optional() }))
      .use(rateLimited())
      .mutation(async ({ ctx, input }) => {
        const { id, subscriptionId } = input;

        const userId = ctx.user?.id;
        if (!userId) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "Please sign in to manage tracked routes." });
        }

        const effectiveSubId = ctx.user?.paypalSubscriptionId ?? subscriptionId;
        if (!(await isActiveSubscriber(effectiveSubId))) {
          throw new TRPCError({ code: "FORBIDDEN", message: "An active Premium subscription is required to manage tracked routes." });
        }

        // Ownership is checked BEFORE the delete and inside the same query, so a
        // refusal cannot cost a row and there is no window where an id is known to
        // be valid but not yet proven to be ours. A route owned by someone else is
        // reported as not-found rather than forbidden - confirming an id exists is
        // itself a leak.
        const removed = await removeTrackedRouteForUser(id, userId);
        if (!removed) {
          throw new TRPCError({ code: "NOT_FOUND", message: "That route is not on your watch list." });
        }
        return { success: true };
      }),
    // Admin only: one call refreshes EVERY tracked route, spends the alert pool and
    // sends Telegram messages. Left public it was a notification-spam lever, not just
    // a quota risk.
    scan: adminProcedure.use(rateLimited()).mutation(async () => {
      const result = await scanTrackedRoutes();
      const notifications = await Promise.all(result.alerts.filter(item => item.notified).map(item => sendPriceDropNotification(item.route, item.dropPercent)));
      return { ...result, notifications };
    }),
  }),
  billing: router({
    pricing: publicProcedure.query(() => premiumPlan),
    pricingPayPal: publicProcedure.query(() => getPremiumPlanPayPalLive()),
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
