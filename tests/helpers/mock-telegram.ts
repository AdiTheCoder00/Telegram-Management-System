import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Minimal fake of the Telegram Bot API for tests and local end-to-end runs.
 * Valid token: anything matching VALID_TOKEN. Valid chats: VALID_CHATS. Behaviour can be switched
 * to simulate outages (`mode = "down"`), rate limiting (`mode = "ratelimit"`) etc.
 */
export const VALID_TOKEN = "123456789:AAH-valid-token-for-tests-0123456789ab";
export const VALID_CHATS = new Set(["-1001234567890", "42"]);
/** An old group ID that Telegram reports as upgraded to the supergroup -1001234567890. */
export const MIGRATED_CHAT = "-4000000001";

export interface SentMessage {
  chat_id: string;
  text: string;
  parse_mode?: string;
}

export interface MockTelegram {
  url: string;
  sent: SentMessage[];
  mode: "ok" | "down" | "ratelimit";
  close(): Promise<void>;
}

export async function startMockTelegram(port = 0): Promise<MockTelegram> {
  const state: MockTelegram = { url: "", sent: [], mode: "ok", close: async () => undefined };
  let messageId = 1000;

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const reply = (status: number, json: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      // Inspection endpoints for local end-to-end runs
      if (req.url === "/__sent") return reply(200, state.sent);
      const modeMatch = req.url?.match(/^\/__mode\/(ok|down|ratelimit)$/);
      if (modeMatch) {
        state.mode = modeMatch[1] as MockTelegram["mode"];
        return reply(200, { mode: state.mode });
      }
      if (state.mode === "down") return reply(502, { ok: false, error_code: 502, description: "Bad Gateway" });
      if (state.mode === "ratelimit")
        return reply(429, { ok: false, error_code: 429, description: "Too Many Requests: retry after 1", parameters: { retry_after: 1 } });

      const m = req.url?.match(/^\/bot([^/]+)\/(\w+)$/);
      if (!m) return reply(404, { ok: false, error_code: 404, description: "Not Found" });
      const [, token, method] = m;
      if (token !== VALID_TOKEN) return reply(401, { ok: false, error_code: 401, description: "Unauthorized" });
      const payload = body ? JSON.parse(body) : {};

      if (method === "getMe")
        return reply(200, { ok: true, result: { id: 123456789, is_bot: true, first_name: "Test Bot", username: "test_alerts_bot" } });
      const chatId = String(payload.chat_id ?? "");
      if (chatId === MIGRATED_CHAT)
        return reply(400, {
          ok: false,
          error_code: 400,
          description: "Bad Request: group chat was upgraded to a supergroup chat",
          parameters: { migrate_to_chat_id: -1001234567890 },
        });
      if (!VALID_CHATS.has(chatId)) return reply(400, { ok: false, error_code: 400, description: "Bad Request: chat not found" });
      if (method === "getChat")
        return reply(200, { ok: true, result: { id: Number(chatId), type: "supergroup", title: "Trading Alerts" } });
      if (method === "sendMessage") {
        if (payload.parse_mode === "MarkdownV2" && /(?<!\\)[.!]/.test(payload.text))
          return reply(400, { ok: false, error_code: 400, description: "Bad Request: can't parse entities: Character '.' is reserved" });
        state.sent.push({ chat_id: chatId, text: payload.text, parse_mode: payload.parse_mode });
        return reply(200, {
          ok: true,
          result: { message_id: ++messageId, date: Math.floor(Date.now() / 1000), chat: { id: Number(chatId), type: "supergroup" } },
        });
      }
      return reply(404, { ok: false, error_code: 404, description: "Not Found: method not found" });
    });
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise((resolve) => server.close(() => resolve()));
  return state;
}
