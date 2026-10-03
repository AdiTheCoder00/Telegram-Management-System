/**
 * Runs a fake Telegram Bot API on http://127.0.0.1:8081 for local end-to-end testing without a real bot.
 *   npm run telegram:mock
 *   TELEGRAM_API_URL=http://127.0.0.1:8081 npm run dev   (and the same for npm run worker)
 * Valid token: see tests/helpers/mock-telegram.ts (VALID_TOKEN); valid chat ids: -1001234567890, 42.
 * GET /__sent lists received messages; GET /__mode/down simulates an outage, /__mode/ok restores it.
 */
import { startMockTelegram, VALID_TOKEN } from "../tests/helpers/mock-telegram";

const port = Number(process.env.MOCK_TELEGRAM_PORT ?? 8081);
const tg = await startMockTelegram(port);
console.log(`[mock-telegram] listening on ${tg.url}  token=${VALID_TOKEN}  chats=-1001234567890,42`);

let seen = 0;
setInterval(() => {
  for (const m of tg.sent.slice(seen)) console.log(`[mock-telegram] → chat ${m.chat_id} (${m.parse_mode ?? "plain"}):\n${m.text}\n`);
  seen = tg.sent.length;
}, 250);
