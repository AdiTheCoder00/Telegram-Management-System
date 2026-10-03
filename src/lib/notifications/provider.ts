import { decrypt } from "@/lib/crypto";
import { logger } from "@/lib/logger";
import { sendMessage, TelegramError } from "@/lib/telegram/client";
import { applyChatMigration } from "@/lib/telegram/migration";
import type { ParseModeT } from "@/lib/constants";

/**
 * Notification provider contract (M20). A provider only delivers a message and reports the outcome;
 * it never decides whether an alert triggered and never touches delivery state — the pipeline in
 * delivery.ts owns retries, dead-lettering and records. New channels (Discord, email, …) implement this.
 */
export interface NotificationMessage {
  deliveryId: string;
  text: string;
  parseMode: ParseModeT;
  isTest: boolean;
}

export type SendResult =
  | { ok: true; providerMessageId: string; notes: string[]; destinationChanged?: string }
  | {
      ok: false;
      retryable: boolean;
      retryAfterSec?: number;
      userMessage: string;
      detail: string;
      /** The destination itself is broken (bad token / chat) — the pipeline flags the bot and alert. */
      destinationBroken: boolean;
    };

export interface NotificationProvider {
  readonly channel: "TELEGRAM";
  send(message: NotificationMessage): Promise<SendResult>;
}

export interface TelegramDestination {
  botId: string;
  encryptedToken: string;
  chatId: string;
}

/** Telegram Bot API provider: decrypts the token, follows supergroup migrations, falls back to plain text. */
export class TelegramProvider implements NotificationProvider {
  readonly channel = "TELEGRAM" as const;

  constructor(private dest: TelegramDestination) {}

  async send(m: NotificationMessage): Promise<SendResult> {
    let token: string;
    try {
      token = decrypt(this.dest.encryptedToken);
    } catch (err) {
      logger.error("Failed to decrypt bot token (ENCRYPTION_KEY changed?)", { botId: this.dest.botId, err });
      return {
        ok: false,
        retryable: false,
        userMessage: "The stored bot token could not be read. Please re-enter the bot token.",
        detail: "decrypt_failed",
        destinationBroken: true,
      };
    }

    let chatId = this.dest.chatId;
    const notes: string[] = [];
    let changed: string | undefined;
    const attempt = async (mode: ParseModeT) => {
      try {
        return await sendMessage(token, chatId, m.text, mode);
      } catch (err) {
        if (err instanceof TelegramError && err.kind === "chat_migrated" && err.migrateToChatId && err.migrateToChatId !== chatId) {
          await applyChatMigration(this.dest.botId, chatId, err.migrateToChatId);
          notes.push(`Sent to the new Chat ID ${err.migrateToChatId} (was ${chatId}; group upgraded to supergroup).`);
          chatId = err.migrateToChatId;
          changed = chatId;
          return await sendMessage(token, chatId, m.text, mode);
        }
        throw err;
      }
    };

    try {
      let msg;
      try {
        msg = await attempt(m.parseMode);
      } catch (err) {
        // Invalid formatting: deliver as plain text rather than lose the alert.
        if (err instanceof TelegramError && err.kind === "parse_error" && m.parseMode !== "PLAIN") {
          msg = await attempt("PLAIN");
          notes.push("Sent as plain text because Telegram could not parse the message formatting.");
        } else throw err;
      }
      return { ok: true, providerMessageId: String(msg.message_id), notes, destinationChanged: changed };
    } catch (err) {
      const tg = err instanceof TelegramError ? err : new TelegramError("network", String(err));
      return {
        ok: false,
        retryable: tg.retryable,
        retryAfterSec: tg.retryAfterSec,
        userMessage: tg.userMessage,
        detail: `${tg.kind}: ${tg.description}`,
        destinationBroken: ["invalid_token", "chat_not_found", "bot_blocked"].includes(tg.kind),
      };
    }
  }
}
