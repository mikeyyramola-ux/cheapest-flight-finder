import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { adminProcedure, publicProcedure, router } from "./_core/trpc";
import { addTrackedRoute, getSeedHistory, listTrackedRoutes, removeTrackedRoute, scanTrackedRoutes, searchFlights, sendPriceDropNotification } from "./flight-data";
import { createPremiumCheckout, premiumPlan } from "./stripe";
import { getPartnerHealthReport } from "./partner-health";

const searchInput = z.object({
  origin: z.string().min(3).max(3),
  destination: z.string().min(3).max(3),
  departureDate: z.string(),
  returnDate: z.string().optional(),
  passengers: z.number().int().min(1).max(9),
});

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
    history: publicProcedure.input(z.object({ origin: z.string(), destination: z.string() })).query(({ input }) => ({ points: getSeedHistory(input.origin, input.destination), gated: false })),
  }),
  tracker: router({
    list: publicProcedure.query(() => ({ routes: listTrackedRoutes(), plan: "demo-free" as const })),
    add: publicProcedure.input(z.object({ origin: z.string().min(3), destination: z.string().min(3), departDate: z.string(), returnDate: z.string(), targetPrice: z.number().min(1), alertChannel: z.enum(["Telegram", "WhatsApp"]) })).mutation(({ input }) => ({ route: addTrackedRoute(input), upgraded: true })),
    remove: publicProcedure.input(z.object({ id: z.string() })).mutation(({ input }) => ({ success: removeTrackedRoute(input.id) })),
    scan: publicProcedure.mutation(async () => {
      const result = scanTrackedRoutes();
      const notifications = await Promise.all(result.alerts.filter(item => item.notified).map(item => sendPriceDropNotification(item.route, item.dropPercent)));
      return { ...result, notifications };
    }),
  }),
  billing: router({
    pricing: publicProcedure.query(() => premiumPlan),
    checkout: publicProcedure.input(z.object({ route: z.string().optional() })).mutation(async ({ ctx, input }) => createPremiumCheckout({ origin: input.route ?? "dashboard", userId: ctx.user?.id, email: ctx.user?.email, name: ctx.user?.name })),
  }),
  monitoring: router({
    partners: adminProcedure.query(() => getPartnerHealthReport()),
  }),
});

export type AppRouter = typeof appRouter;
