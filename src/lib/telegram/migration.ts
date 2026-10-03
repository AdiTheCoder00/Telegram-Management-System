import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * When a Telegram group is upgraded to a supergroup its chat ID changes permanently and Telegram returns
 * the new one (`migrate_to_chat_id`). The old ID never works again, so the bot is updated in place.
 * Conditional on the old value → idempotent and safe under concurrent deliveries.
 */
export async function applyChatMigration(botId: string, fromChatId: string, toChatId: string) {
  const { count } = await db.telegramBot.updateMany({
    where: { id: botId, chatId: fromChatId },
    data: {
      chatId: toChatId,
      lastError: `Chat ID updated automatically from ${fromChatId} to ${toChatId} (group upgraded to supergroup).`,
    },
  });
  if (count) logger.info("Telegram chat migrated", { botId, fromChatId, toChatId });
  return count > 0;
}
