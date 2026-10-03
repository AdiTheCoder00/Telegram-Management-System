# Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| "Telegram rejected the bot token" | The token was revoked or mistyped. Create a new token in @BotFather (`/token`), then Edit the bot. If `TELEGRAM_API_URL` points at the mock server (`npm run telegram:mock`), real tokens are rejected — remove it. |
| "That Chat ID is a bot" | You entered the bot's own id/@username. Open your bot in Telegram, press **Start**, then Edit → **Find my chat**. |
| "chat not found" / "bot was blocked" | Press Start in the chat, or add the bot to the group/channel (as admin for channels). |
| Group stopped receiving messages | The group was upgraded to a supergroup; the app follows the migration automatically on the next send. |
| Dashboard: "worker not running" | Start `npm run worker`. Alerts are not evaluated and messages are not sent without it. |
| Condition alert "waiting: stale data" | The provider's latest closed candle is overdue (market closed, provider outage, wrong symbol). See System → providers. |
| "Not enough history (5m: 40/88 bars)" | The fixed indicator window needs more bars. Wait, choose a lower lookback, or (webhook feeds) push more history. |
| Alert fired once and stopped | Trigger mode **Once**, or **Re-arm** waiting for the conditions to become false. The Debug page tells you which. |
| Backtest "Range too large" | Max 50 000 base bars. Shorten the range or use a higher timeframe. |
| Backtest stuck in QUEUED | The worker is not running (backtests run there). |
| Backtest FAILED "Interrupted" | The worker restarted mid-run. Run it again. |
| Twelve Data "budget exhausted" | Free tier is 8 requests/min. The app spreads requests; raise `TWELVE_DATA_RATE_LIMIT_PER_MIN` on paid plans. |
| TradingView webhook 401 | Wrong/disabled secret, or the URL is a generic webhook (`/api/webhooks/<id>` needs the header). Recreate it under Settings → Webhooks. |
| TradingView webhook never arrives | A local app is not reachable from the internet. Use a tunnel or deploy. |
| `P1001` / `ECONNRESET` from Prisma | PostgreSQL is down. Local: `npm run db:local`. If it hangs: `node_modules/@embedded-postgres/<platform>/native/bin/pg_ctl stop -D .pgdata -m fast`, then start again. |
| Errors right after a migration | The web server or worker still holds the old Prisma client — restart both. |
| Dev console "hydration mismatch" in the message preview | Fixed (the preview's clock is excluded); hard-reload the page if it persists after updating. |

## Getting more detail

- `LOG_LEVEL=debug` for the worker and web server (secrets are scrubbed from logs).
- Alerts → ⋯ → **Debug conditions**: runs the live path now or at a past time and explains the decision.
- History → **Why?** on any trigger: the stored evidence.
- System page: health, provider errors, queue depths, oldest pending notification, audit log.
