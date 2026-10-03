import { z } from "zod";
import { route, parseBody } from "@/lib/api";
import { badRequest } from "@/lib/errors";
import { decrypt } from "@/lib/crypto";
import { botTokenSchema } from "@/lib/validation";
import { getOwnedBot } from "@/lib/services/bots";
import { discoverChats, TelegramError } from "@/lib/telegram/client";

const schema = z.union([z.object({ token: botTokenSchema }), z.object({ botId: z.string().min(1).max(40) })]);

/**
 * POST /api/telegram/discover-chats — { token } (add-bot form) or { botId } (saved bot).
 * Lists chats the bot has recently seen so the user can pick a Chat ID. Read-only: never consumes updates.
 */
export const POST = route(
  async ({ req, user }) => {
    const input = await parseBody(req, schema);
    let token: string;
    if ("token" in input) token = input.token;
    else {
      const bot = await getOwnedBot(user.id, input.botId);
      try {
        token = decrypt(bot.encryptedToken);
      } catch {
        throw badRequest("The stored bot token could not be read. Please re-enter the token.");
      }
    }
    try {
      return await discoverChats(token);
    } catch (err) {
      if (err instanceof TelegramError) throw badRequest(err.userMessage);
      throw err;
    }
  },
  { rateLimit: [20, 60_000], bucket: "discover-chats" },
);
