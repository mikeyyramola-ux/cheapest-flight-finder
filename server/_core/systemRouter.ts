import { z } from "zod";
import { notifyOwner } from "./notification";
import { getTelegramBotUsername } from "../telegram";
import { adminProcedure, publicProcedure, router } from "./trpc";

export const systemRouter = router({
  health: publicProcedure
    .input(
      z.object({
        timestamp: z.number().min(0, "timestamp cannot be negative"),
      })
    )
    .query(() => ({
      ok: true,
    })),

  /**
   * Public, unauthenticated, and returns ONLY the bot's public username - never the
   * token. The sign-up page needs a t.me link so a customer can press Start on the
   * bot before we try to message them; without that, Telegram refuses our message
   * with a 403 and the alert silently cannot reach them.
   *
   * Null is a normal answer, not an error: the page falls back to plain wording.
   */
  telegramBotUsername: publicProcedure.query(async () => ({
    username: await getTelegramBotUsername(),
  })),

  notifyOwner: adminProcedure
    .input(
      z.object({
        title: z.string().min(1, "title is required"),
        content: z.string().min(1, "content is required"),
      })
    )
    .mutation(async ({ input }) => {
      const delivered = await notifyOwner(input);
      return {
        success: delivered,
      } as const;
    }),
});
