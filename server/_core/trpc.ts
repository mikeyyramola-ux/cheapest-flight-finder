import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { clientIp, DAILY_LIMIT_WINDOW_MS, hitRateLimit, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from "./rate-limit";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = t.procedure.use(requireUser);

export const adminProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== 'admin') {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);

/**
 * Per-IP caps for the procedures that spend supplier credits or fire notifications.
 *
 * Keyed by `ip|path`, never `ip` alone: a page load fires several unrelated queries,
 * and a single global budget across /api/trpc would throttle ordinary browsing rather
 * than the attacker. The daily window is opt-in so admin and subscriber routes are not
 * capped at ten calls a day.
 */
export const rateLimited = (options?: { perMinute?: number; perDay?: number }) =>
  t.middleware(async opts => {
    const { ctx, next } = opts;
    const ip = clientIp(ctx.req?.headers, ctx.req?.ip);

    if (!hitRateLimit(`${ip}|${opts.path}|m`, options?.perMinute ?? RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "Too many requests. Try again in a minute.",
      });
    }

    if (options?.perDay !== undefined && !hitRateLimit(`${ip}|${opts.path}|d`, options.perDay, DAILY_LIMIT_WINDOW_MS)) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "Daily limit reached for this address. Try again tomorrow.",
      });
    }

    return next({ ctx: { ...ctx } });
  });
