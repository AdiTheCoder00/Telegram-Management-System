import { logger, scrubSecrets } from "@/lib/logger";
import type { ParseModeT } from "@/lib/constants";

/**
 * Thin client for the official Telegram Bot API (https://core.telegram.org/bots/api).
 * The base URL is configurable (TELEGRAM_API_URL) so a local Bot API server or a mock can be used.
 */

export type TelegramErrorKind =
  | "invalid_token"
  | "chat_not_found"
  | "chat_migrated"
  | "bot_blocked"
  | "parse_error"
  | "bad_request"
  | "rate_limited"
  | "server_error"
  | "network";

export class TelegramError extends Error {
  constructor(
    public kind: TelegramErrorKind,
    public description: string,
    public httpStatus?: number,
    public retryAfterSec?: number,
    /** Set when a group was upgraded to a supergroup: Telegram reports the chat's new permanent ID. */
    public migrateToChatId?: string,
  ) {
    super(description);
    this.name = "TelegramError";
  }

  /** Transient errors are retried by the worker; permanent ones fail the delivery immediately. */
  get retryable() {
    return this.kind === "rate_limited" || this.kind === "server_error" || this.kind === "network";
  }

  /** Friendly, user-facing explanation (raw Telegram errors are kept in the logs). */
  get userMessage(): string {
    switch (this.kind) {
      case "invalid_token":
        return "Telegram rejected the bot token. Please check the token from @BotFather.";
      case "chat_not_found":
        return "Telegram could not find that chat. Check the Chat ID and make sure the bot was added to the chat/channel.";
      case "chat_migrated":
        return `This group was upgraded to a supergroup and its Chat ID changed${this.migrateToChatId ? ` to ${this.migrateToChatId}` : ""}.`;
      case "bot_blocked":
        return "The bot is not allowed to post in this chat. Unblock the bot or give it permission to send messages.";
      case "parse_error":
        return "Telegram could not parse the message formatting. Check your Markdown/HTML syntax.";
      case "bad_request":
        return "Telegram message could not be delivered. Please check your bot token and Chat ID.";
      case "rate_limited":
        return `Telegram rate limit reached. Retrying${this.retryAfterSec ? ` in ${this.retryAfterSec}s` : ""}.`;
      case "server_error":
        return "Telegram is temporarily unavailable. The message will be retried automatically.";
      case "network":
        return "Could not reach Telegram. The message will be retried automatically.";
    }
  }
}

function classify(status: number, description: string, migrateTo?: number): TelegramErrorKind {
  const d = description.toLowerCase();
  if (migrateTo !== undefined || d.includes("upgraded to a supergroup")) return "chat_migrated";
  if (status === 401 || d.includes("unauthorized")) return "invalid_token";
  if (status === 404) return "invalid_token"; // /bot<bad token>/method returns 404 Not Found
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  if (d.includes("chat not found") || d.includes("chat_id is empty") || d.includes("peer_id_invalid")) return "chat_not_found";
  if (status === 403 || d.includes("bot was blocked") || d.includes("not enough rights") || d.includes("kicked")) return "bot_blocked";
  if (d.includes("can't parse entities") || d.includes("can't find end")) return "parse_error";
  return "bad_request";
}

const TIMEOUT_MS = 10_000;

function apiBase() {
  return (process.env.TELEGRAM_API_URL || "https://api.telegram.org").replace(/\/+$/, "");
}

export async function callTelegram<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
  const url = `${apiBase()}/bot${token}/${method}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    logger.warn("Telegram request failed (network)", { method, err: scrubSecrets(String(err)) });
    throw new TelegramError("network", "Network error contacting Telegram");
  }

  let json: {
    ok: boolean;
    result?: T;
    description?: string;
    error_code?: number;
    parameters?: { retry_after?: number; migrate_to_chat_id?: number };
  };
  try {
    json = await res.json();
  } catch {
    throw new TelegramError(res.status >= 500 ? "server_error" : "bad_request", `Invalid response (HTTP ${res.status})`, res.status);
  }
  if (!res.ok || !json.ok) {
    const description = json.description ?? `HTTP ${res.status}`;
    const status = json.error_code ?? res.status;
    const migrateTo = json.parameters?.migrate_to_chat_id;
    const kind = classify(status, description, migrateTo);
    logger.warn("Telegram API error", { method, status, description });
    throw new TelegramError(
      kind,
      description,
      status,
      json.parameters?.retry_after,
      migrateTo !== undefined ? String(migrateTo) : undefined,
    );
  }
  return json.result as T;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}
export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
}
export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  date: number;
}

export const getMe = (token: string) => callTelegram<TelegramUser>(token, "getMe", {});

export const getChat = (token: string, chatId: string) => callTelegram<TelegramChat>(token, "getChat", { chat_id: chatId });

export const TELEGRAM_PARSE_MODE: Record<ParseModeT, string | undefined> = {
  PLAIN: undefined,
  MARKDOWN: "Markdown",
  MARKDOWN_V2: "MarkdownV2",
  HTML: "HTML",
};

export function sendMessage(token: string, chatId: string, text: string, parseMode: ParseModeT = "PLAIN") {
  return callTelegram<TelegramMessage>(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: TELEGRAM_PARSE_MODE[parseMode],
    link_preview_options: { is_disabled: true },
  });
}

interface TelegramUpdate {
  update_id: number;
  message?: { chat: TelegramChat; date: number };
  edited_message?: { chat: TelegramChat; date: number };
  channel_post?: { chat: TelegramChat; date: number };
  my_chat_member?: { chat: TelegramChat; date: number };
}

export interface DiscoveredChat {
  id: string;
  type: TelegramChat["type"];
  title: string;
  lastSeen: number; // unix seconds
}

function chatTitle(chat: TelegramChat) {
  return chat.title ?? (chat.username ? `@${chat.username}` : chat.first_name) ?? String(chat.id);
}

/**
 * Lists chats the bot has recently seen (messages, channel posts, being added to a group), newest first,
 * so the user can pick a Chat ID instead of copying it from raw getUpdates output.
 * No `offset` is sent, so updates are NOT acknowledged/consumed — this is read-only for the bot.
 * Telegram keeps pending updates for 24 h; a bot with a webhook set cannot use getUpdates (409).
 */
export async function discoverChats(token: string) {
  const me = await getMe(token);
  let updates: TelegramUpdate[];
  try {
    updates = await callTelegram<TelegramUpdate[]>(token, "getUpdates", { limit: 100, timeout: 0 });
  } catch (err) {
    if (err instanceof TelegramError && err.httpStatus === 409) {
      return {
        botUsername: me.username ?? me.first_name,
        chats: [] as DiscoveredChat[],
        error: "This bot has a webhook set, so its recent chats can't be listed. Enter the Chat ID manually.",
      };
    }
    throw err;
  }
  const byId = new Map<string, DiscoveredChat>();
  for (const u of updates) {
    const src = u.message ?? u.edited_message ?? u.channel_post ?? u.my_chat_member;
    if (!src) continue;
    const id = String(src.chat.id);
    const prev = byId.get(id);
    if (!prev || prev.lastSeen < src.date) byId.set(id, { id, type: src.chat.type, title: chatTitle(src.chat), lastSeen: src.date });
  }
  return {
    botUsername: me.username ?? me.first_name,
    chats: [...byId.values()].sort((a, b) => b.lastSeen - a.lastSeen),
    error: null as string | null,
  };
}

/** Verifies token + chat: returns bot identity and chat title, or throws TelegramError. */
export async function verifyConnection(token: string, chatId: string) {
  const me = await getMe(token);
  const chat = await getChat(token, chatId);
  return { botUsername: me.username ?? me.first_name, chatTitle: chatTitle(chat), chatType: chat.type };
}
