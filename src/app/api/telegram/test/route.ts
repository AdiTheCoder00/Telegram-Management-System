import { route, parseBody } from "@/lib/api";
import { telegramTestSchema } from "@/lib/validation";
import { sendAdHocTestMessage, sendBotTestMessage } from "@/lib/services/bots";

/** POST /api/telegram/test — { botId } for a saved bot, or { token, chatId } to test before saving. */
export const POST = route(
  async ({ req, user }) => {
    const input = await parseBody(req, telegramTestSchema);
    if ("botId" in input) return { result: await sendBotTestMessage(user.id, input.botId, input.message, input.parseMode) };
    return { result: await sendAdHocTestMessage(input.token, input.chatId, input.message) };
  },
  { rateLimit: [10, 60_000], bucket: "telegram-test" },
);
