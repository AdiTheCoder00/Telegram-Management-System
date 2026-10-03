# Levels — Telegram price alerts

Create price alerts for any instrument and get a Telegram message the moment price reaches your level, once, not every few seconds.

- **Web app**: Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, shadcn/ui, Lucide.
- **Backend**: Next.js route handlers plus a separate **background worker** (the alert engine keeps running when no browser is open).
- **Database**: PostgreSQL via Prisma 7.
- **Queue**: Redis + BullMQ (optional). Without Redis, a database outbox is used.
- **Telegram**: the official Bot API (`sendMessage`, `getMe`, `getChat`).

```
Market data ─▶ price tick ─▶ Alert engine ─▶ condition ─▶ trigger protection ─▶ message template
   (poll / webhook)            (worker or web)   evaluation   (armed/cooldown/        │
                                                              optimistic lock)        ▼
                                Delivery log ◀── Telegram Bot API ◀── worker ◀── queue / outbox
```

## Trading platform features

Beyond single price levels, Levels is a personal alert and backtesting platform:

- **Indicator-condition alerts**: 21 indicators, crossings, candle patterns, trading sessions and several
  timeframes in one rule set. Rules are evaluated on candle close (default) or intrabar. Starts from templates.
- **One engine everywhere**: live alerts, the **debugger** (Alerts → ⋯ → Debug conditions) and **backtests** use
  the same windows, evaluator and trigger state machine. No look-ahead, and "backtest == live" is tested.
- **Trigger evidence**: History → **Why?** shows exactly which values fired an alert, the candle used, the data
  source and the alert version.
- **Backtest** page: forward moves, MFE/MAE, per-trigger evidence and a chart. Runs are reproducible, with a
  dataset SHA-256 and engine versions.
- **TradingView webhooks** for prices or OHLC bars (Settings → Webhooks).
- **Live monitor** (dashboard, SSE), **Analytics** (History → Analytics), **System** page (health, providers,
  queues, pause/resume all, reconnect, retry failed notifications, audit log).
- Groups, bulk actions, JSON import/export, immutable alert versions, backups (`npm run db:backup`).

Documentation: [architecture](docs/architecture.md) · [alert engine](docs/alert-engine.md) ·
[market data](docs/market-data.md) · [candle semantics](docs/candle-semantics.md) ·
[backtesting](docs/backtesting.md) · [reliability & backups](docs/reliability.md) ·
[deployment](docs/deployment.md) · [troubleshooting](docs/troubleshooting.md)

---

## 1. Install dependencies

Requires Node.js ≥ 20.9.

```bash
npm install
```

`postinstall` runs `prisma generate`. With npm 11, approve the native install scripts if prompted: `npm install-scripts approve prisma @prisma/engines esbuild`.

## 2. Configure `.env`

```bash
cp .env.example .env
```

| Variable                                                                    | Required | Purpose                                                                                             |
| --------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                              | yes      | PostgreSQL connection string                                                                        |
| `NEXTAUTH_SECRET`                                                           | prod     | HMAC key for session-token hashing (`openssl rand -base64 32`)                                      |
| `ENCRYPTION_KEY`                                                            | prod     | 32-byte base64 key used to encrypt bot tokens (AES-256-GCM). **Never change it after saving bots.** |
| `APP_URL`                                                                   | prod     | Public URL, used for the origin (CSRF) check behind proxies                                         |
| `TELEGRAM_API_URL`                                                          | no       | Defaults to `https://api.telegram.org`                                                              |
| `REDIS_URL`                                                                 | no       | Enables BullMQ (recommended in production)                                                          |
| `WEBHOOK_SECRET`                                                            | no       | Operator secret for the shared price webhook stream                                                 |
| `CRON_SECRET`                                                               | no       | Protects `/api/cron/poll` (serverless polling)                                                      |
| `DEFAULT_MARKET_DATA_PROVIDER`                                              | no       | `simulated` (default), `binance`, `twelvedata`, `custom`, `webhook`                                 |
| `MARKET_DATA_API_KEY`                                                       | no       | API key for Twelve Data or the custom provider                                                      |
| `CUSTOM_PRICE_URL`, `CUSTOM_PRICE_JSON_PATH`, `CUSTOM_PRICE_API_KEY_HEADER` | no       | Generic REST provider                                                                               |
| `PRICE_POLL_INTERVAL_MS`                                                    | no       | Worker polling interval (default 5000)                                                              |
| `MAX_ALERTS_PER_USER`, `MAX_BOTS_PER_USER`                                  | no       | Plan limits (default 500 / 20)                                                                      |

The environment is validated when the web server (`src/instrumentation.ts`) and the worker start. Malformed values (e.g. a wrong-length `ENCRYPTION_KEY`, a `REDIS_URL` without `redis://`) abort startup with a clear log message. In development, missing `NEXTAUTH_SECRET`/`ENCRYPTION_KEY` fall back to fixed dev values with a warning. With `NODE_ENV=production` they are mandatory and the process refuses to start without them.

## 3. Set up PostgreSQL

Pick one:

- **Docker**: `docker compose up -d db redis`, then `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/telegram_alerts`
- **Managed**: create a database on Neon, Supabase or RDS and paste its URL. Use the pooled URL for the app and keep `sslmode=require`.
- **No Docker, no install**: `npm run db:local` starts a real PostgreSQL from the `embedded-postgres` package on port 5433. Use `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/telegram_alerts`.

The database must be **UTF-8**: messages contain emoji.

## 4. Run migrations (and seed)

```bash
npm run db:deploy   # apply migrations (prisma migrate deploy)
npm run db:seed     # instruments: XAUUSD, BTCUSD, EURUSD, GBPUSD, NAS100, US30, …
```

Use `npm run db:migrate` (`prisma migrate dev`) when you change `prisma/schema.prisma`.

**After any migration, restart `npm run dev` and the worker.** Running processes keep the Prisma client they started with. A new column would otherwise surface as "Something went wrong" (the log shows `Unknown argument`).

## 5. Start Redis (optional)

```bash
docker compose up -d redis   # REDIS_URL=redis://localhost:6379
```

Without `REDIS_URL` everything still works. Deliveries are written to the `TelegramDelivery` table (a transactional outbox) and the worker sends them within about a second.

## 6. Start the development server

```bash
npm run dev          # http://localhost:3000
```

**First run:** open the app and create the **owner account** (you're redirected to `/register`). It starts in your browser's time zone, which you can change under Settings. Registration then closes: this is a personal installation. Set `ALLOW_REGISTRATION=true` to temporarily allow another account.

Under **Settings → Security** you can change your password (which signs out every other device) and see or sign out signed-in devices. Sessions expire after 30 days without use and are renewed while you use the app.

## 7. Run the background worker

```bash
npm run worker       # or: npm run worker:dev (auto-reload)
```

The worker polls market data for every active alert, runs the engine, sends Telegram messages with retries and rate limiting, expires dated alerts, and writes a heartbeat. The dashboard shows "Alert engine running" while a worker is alive.

## 8. Create a Telegram bot

1. In Telegram, open **@BotFather** → `/newbot` → copy the token (`123456:ABC…`).
2. Add the bot to the destination: a private chat (press _Start_), a group, or a channel as an **admin with "Post messages"**.

## 9. Configure the Chat ID

1. Send any message in that chat.
2. Open `https://api.telegram.org/bot<token>/getUpdates` and copy `message.chat.id` (groups/channels look like `-1001234567890`). Public channels can use `@channelname`.
3. In the app go to **Telegram Bots → Add a Telegram bot**, paste the name, token and chat ID, click **Send test message**, then **Save bot**. The bot shows **Connected** when `getMe`/`getChat` succeed.

## 10. Create your first alert

**Dashboard → Create Alert** (or a quick template: Price Above / Below / Breakout / Breakdown).

1. **Alert details**: name, symbol (chips or any custom symbol), price source.
2. **Condition**: Above (≥), Below (≤), Crosses Above, Crosses Below, Equals (± tolerance) and the target price. The level ladder on the right shows current price, target, distance and distance %.
3. **Trigger settings**: frequency (Once / Every time / Re-arm), cooldown, expiration.
4. **Telegram**: choose the bot/chat.
5. **Message**: edit the template, click variables to insert them, and pick Plain / Markdown / MarkdownV2 / HTML.
6. **Preview**: a live Telegram-style preview using the current price.
7. **Review**: a plain-language summary, then **Save Alert**.

## 11. Test the alert

- **Send test to Telegram** in the form sends the rendered message without saving.
- **Alerts → ✈ (Send test alert)** sends the saved alert's real template, marked `🧪 TEST ALERT`, and records it in history (toggle _Include test alerts_).
- **Alerts → ⋯ → Simulate price** feeds a price into the engine for your own alerts. Use it to try `3895 → 3901` end to end.
- Or push prices like TradingView would (key from **Settings → Price webhook keys**):

```bash
curl -X POST http://localhost:3000/api/webhooks/price \
  -H "Authorization: Bearer tam_…" -H "Content-Type: application/json" \
  -d '{"symbol":"XAUUSD","price":3901.25,"timestamp":"2026-10-03T14:35:00Z"}'
```

**Testing without a real bot**: `npm run telegram:mock` starts a fake Bot API on `:8081`. Set `TELEGRAM_API_URL=http://127.0.0.1:8081` for both the app and the worker, and use the token and chat IDs printed by the script.

## 12. Production deployment

The web app is stateless. The **worker must run as a long-lived process** because it is the engine.

**Option A: Vercel + managed services (recommended)**

1. PostgreSQL on Neon/Supabase and Redis on Upstash (TLS `rediss://` URL).
2. Deploy the repo to Vercel. Set every variable from `.env.example`, with `NODE_ENV=production` and `APP_URL=https://your-app.vercel.app`. Run `npm run db:deploy` once against the production DB (locally or in CI).
3. Run the worker on any container host (Railway, Fly.io, Render, ECS) with `npm run worker`, the same env vars and the same `ENCRYPTION_KEY`.
4. _No worker available?_ `vercel.json` schedules `GET /api/cron/poll` every minute (Vercel sends `Authorization: Bearer $CRON_SECRET`). This gives one-minute polling and outbox delivery. Webhook-fed alerts still trigger instantly.

**Option B: Docker Compose (single host)**

```bash
cp .env.example .env   # fill secrets
docker compose up -d --build   # db, redis, migrate, web (:3000), worker
```

**Health endpoints** (no auth; no secrets or user data in responses):

| Endpoint                      | States                                                                                                                               | HTTP                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `GET /api/health`             | `OK` / `DEGRADED` / `DOWN` + one status per component                                                                                | 503 only when the database is down |
| `GET /api/health/database`    | `CONNECTED` / `DISCONNECTED` (+ latency)                                                                                             | 503 if disconnected                |
| `GET /api/health/redis`       | `CONNECTED` / `DISCONNECTED` / `NOT_CONFIGURED` (outbox mode)                                                                        | 503 if disconnected                |
| `GET /api/health/market-data` | per active feed: `FRESH` / `STALE` / `NO_DATA` / `SIMULATED` / `PUSH`; overall `CONNECTED` / `DEGRADED` / `STALE` / `NOT_CONFIGURED` | 503 if stale                       |
| `GET /api/health/workers`     | `RUNNING` / `STOPPED` (heartbeat within 30 s)                                                                                        | 503 if stopped                     |

Simulated (mock) prices are never reported as live: they make market data `DEGRADED`.

## Timestamps

All timestamp columns are `timestamptz` and every database session is pinned to UTC, so stored instants never depend on the server's time zone. Convert to local time only for display. The test database deliberately runs in `Asia/Kolkata` to catch regressions.

Scaling: run more `web` replicas freely. Multiple workers are safe. With Redis, BullMQ's job scheduler runs exactly one poll per interval across replicas, and every trigger is protected by optimistic locking and every delivery by an atomic claim.

---

## How alerts behave (anti-spam rules)

| Mode                 | Behaviour                                                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Re-arm** (default) | Fires once, then stays silent until price goes back to the other side of the target (for _Above 3900_: below 3900). `3895 → 3901` fires; `3901, 3902, 3950` stay silent; `3895 → 3902` fires again. |
| **Once**             | Fires one time and the alert becomes **Triggered**. Resume it to arm it again.                                                                                                                      |
| **Every time**       | Fires on every price update that meets the condition, limited by the cooldown.                                                                                                                      |

- **Cooldown**: no message within N seconds of the previous one. In Re-arm mode, a crossing during the cooldown is _consumed_: it doesn't arrive late when the cooldown ends.
- **Crosses**: need the previous price on the other side, so a big jump straight across the level is detected. The first price after creating or resuming never counts as a cross.
- **Duplicate/out-of-order prices**: an identical `(timestamp, price)` or an older timestamp is ignored. Webhook items can carry an `id` for idempotency.
- **Expiry**: never, after first trigger, at a date/time, or after N triggers → status **Expired**.
- **Statuses**: Active, Paused, Triggered, Expired, Error. Error means the bot was deleted or Telegram rejected the token/chat; the reason is shown on the alert.

## Security

- Passwords hashed with bcrypt (cost 12). Login timing is equalised for unknown emails.
- Database-backed sessions. The cookie holds a random 256-bit token (`HttpOnly`, `SameSite=Lax`, `Secure` in production). Only an HMAC of it is stored. The database expiry (30-day idle, sliding) is authoritative, expired rows are purged hourly by the worker, and a password change revokes all other sessions.
- Single-owner registration: closed once the owner exists (enforced in the API with a database lock, not only in the UI).
- CSRF: every cookie-authenticated mutating request must come from the app's own origin (`Origin`/`Sec-Fetch-Site` check) plus SameSite cookies.
- Authorization: every query is scoped by `userId`, and other users' resources return 404.
- Zod validation on every endpoint. Prisma queries are parameterised, and the one raw SQL statement uses a tagged template.
- Rate limiting on login, register, tests, webhooks and all API routes (Redis-backed when available).
- Bot tokens are AES-256-GCM encrypted at rest, never returned by any API (only `••••abcd`), and scrubbed from logs.
- Webhooks authenticate with a per-user API key (stored hashed, revocable) or the operator `WEBHOOK_SECRET` (constant-time compare).
- XSS: React escaping everywhere. The Telegram preview builds React elements from a parsed token tree (no `innerHTML`). Template variables are escaped for the chosen parse mode, so data can't inject formatting. Security headers: no framing, nosniff, HSTS.
- Errors: users see friendly messages, and technical details are logged server-side (secrets redacted).

## API

All endpoints return JSON. Session-authenticated endpoints need the `tam_session` cookie (set by login/register). Validation errors return `400 { error, fieldErrors }`.

| Method   | Path                                                                   | Description                                                                                  |
| -------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| POST     | `/api/auth/register`                                                   | `{ name, email, password, timezone? }` → owner account + session (403 once an owner exists)  |
| POST     | `/api/auth/login`                                                      | `{ email, password }`                                                                        |
| POST     | `/api/auth/logout`                                                     | Ends the session                                                                             |
| GET      | `/api/auth/me`                                                         | Current user                                                                                 |
| POST     | `/api/auth/password`                                                   | `{ currentPassword, newPassword }`; signs out all other sessions                             |
| GET      | `/api/auth/sessions`                                                   | Signed-in devices (`current` marks this one)                                                 |
| DELETE   | `/api/auth/sessions/:id`                                               | Sign out one device                                                                          |
| POST     | `/api/auth/sessions/revoke-others`                                     | Sign out every other device                                                                  |
| GET      | `/api/alerts?q=&status=&symbol=&botId=`                                | List alerts (with current price)                                                             |
| POST     | `/api/alerts`                                                          | Create alert (body below)                                                                    |
| GET      | `/api/alerts/:id`                                                      | Get alert                                                                                    |
| PUT      | `/api/alerts/:id`                                                      | Replace alert (changing what's watched re-arms it)                                           |
| DELETE   | `/api/alerts/:id`                                                      | Delete (history is kept)                                                                     |
| POST     | `/api/alerts/:id/test`                                                 | Send test notification now → `{ result: { status: "sent" \| "failed" \| "retry", error? } }` |
| POST     | `/api/alerts/:id/pause`                                                | Pause                                                                                        |
| POST     | `/api/alerts/:id/resume`                                               | Resume (re-arms; resets the trigger budget of Triggered/Expired alerts)                      |
| POST     | `/api/alerts/:id/duplicate`                                            | Create a paused copy                                                                         |
| GET      | `/api/telegram/bots`                                                   | List bots (no tokens)                                                                        |
| POST     | `/api/telegram/bots`                                                   | `{ name, token, chatId }`, verified on save                                                  |
| PUT      | `/api/telegram/bots/:id`                                               | `{ name?, token?, chatId? }`                                                                 |
| DELETE   | `/api/telegram/bots/:id`                                               | Delete; dependent alerts → Error                                                             |
| POST     | `/api/telegram/bots/:id/verify`                                        | `getMe` + `getChat` connection check                                                         |
| POST     | `/api/telegram/test`                                                   | `{ botId, message?, parseMode? }` or `{ token, chatId }` (before saving)                     |
| GET      | `/api/history?symbol=&status=&from=&to=&includeTests=&page=&pageSize=` | Trigger history                                                                              |
| GET      | `/api/deliveries?status=&page=`                                        | Telegram delivery log (message, message id, attempts, error)                                 |
| GET      | `/api/dashboard`                                                       | Stats, Telegram status, engine status, recent alerts/triggers                                |
| GET      | `/api/prices?symbol=&provider=`                                        | Current price for display                                                                    |
| GET      | `/api/providers` · `/api/symbols`                                      | Market-data providers · known instruments                                                    |
| POST     | `/api/simulate`                                                        | `{ symbol, price, provider }`: inject a tick for your own alerts                             |
| GET/PUT  | `/api/settings`                                                        | `{ name?, timezone? }`                                                                       |
| GET/POST | `/api/settings/api-keys` · DELETE `/api/settings/api-keys/:id`         | Webhook keys (raw key returned once)                                                         |
| POST     | `/api/webhooks/price`                                                  | Price webhook (see below)                                                                    |
| GET      | `/api/cron/poll`                                                       | One poll cycle + outbox drain (`Authorization: Bearer $CRON_SECRET`)                         |
| GET      | `/api/health`                                                          | Liveness                                                                                     |

**Alert body**

```json
{
  "name": "Gold Breakout Alert",
  "symbol": "XAUUSD",
  "dataProvider": "webhook",
  "conditionType": "PRICE_ABOVE",
  "targetPrice": 3900,
  "tolerance": 0,
  "telegramBotId": "clx…",
  "messageTemplate": "🚨 {{symbol}} {{current_price}} ≥ {{target_price}}",
  "parseMode": "PLAIN",
  "triggerMode": "REARM",
  "cooldownSeconds": 60,
  "expiryType": "NEVER",
  "expiresAt": null,
  "maxTriggers": null,
  "status": "ACTIVE"
}
```

`conditionType`: `PRICE_ABOVE | PRICE_BELOW | CROSSES_ABOVE | CROSSES_BELOW | PRICE_EQUALS`. `triggerMode`: `ONCE | EVERY_TIME | REARM`. `expiryType`: `NEVER | AFTER_FIRST_TRIGGER | AT_DATE | AFTER_N_TRIGGERS`. `parseMode`: `PLAIN | MARKDOWN | MARKDOWN_V2 | HTML`.

Template variables: `{{symbol}} {{current_price}} {{target_price}} {{condition}} {{alert_name}} {{time}} {{date}} {{percentage_distance}} {{exchange}} {{alert_id}}`.

**Price webhook**

```
POST /api/webhooks/price
Authorization: Bearer <user API key>        (or X-API-Key, X-Webhook-Secret, or ?key= for TradingView)

{ "symbol": "XAUUSD", "price": 3901.25, "timestamp": "2026-10-03T14:35:00Z", "id": "optional-idempotency-key" }
or { "prices": [ { … }, … ] }   (up to 500)

→ 202 { ok, accepted, duplicates, triggered, results: [{ symbol, quote: "new"|"duplicate"|"stale", evaluated, triggered }] }
```

A user API key feeds only that user's alerts that use the **Webhook / TradingView** source. `WEBHOOK_SECRET` feeds every user's webhook alerts (an operator-run feed). For TradingView, set the webhook URL to `https://<app>/api/webhooks/price?key=<key>` and the message to `{"symbol":"{{ticker}}","price":{{close}},"timestamp":"{{timenow}}"}`.

## Project layout

```
prisma/                 schema, migrations, seed
src/app/(auth)          login / register
src/app/(app)           dashboard, alerts, add/edit alert, bots, history, settings
src/app/api             route handlers (thin; logic lives in src/lib/services)
src/lib/engine          evaluate.ts (pure rules) · engine.ts (tick → triggers) · quotes.ts
src/lib/market-data     MarketDataProvider interface, registry, providers (simulated, binance, twelvedata, custom, webhook)
src/lib/notifications   delivery (send/retry/outbox) · messages (templates) · dispatch
src/lib/telegram        Bot API client, formatting/escaping/validation, templates
src/lib/queue           BullMQ + Redis
src/worker              background worker (poller, Telegram consumer, outbox sweep, heartbeat)
tests/                  vitest: unit + integration against a real embedded PostgreSQL
```

## Extending

- **New market-data source** (Polygon, OANDA, a WebSocket stream): implement `MarketDataProvider` in `src/lib/market-data/providers/` and register it in `registry.ts`. Streaming providers implement `subscribe()` and call `processPriceTick()`.
- **New notification channel** (Discord, WhatsApp, email, SMS): `Alert.channel` (`NotificationChannel` enum) is the switch. Add a delivery table/adapter next to `notifications/delivery.ts` and branch in the engine where the delivery row is created.
- **Indicator alerts** (RSI, EMA cross, MACD, volume): add a `ConditionType`, keep parameters in `Alert.conditionParams` (JSON), and extend `conditionMet()`. The engine, anti-spam and delivery stay the same.
- **Plans, limits, teams**: `src/lib/plans.ts` is the single place limits are resolved from.

## Code quality

```bash
npm run lint          # ESLint (next/core-web-vitals + typescript, Prettier-compatible)
npm run format        # Prettier (write); npm run format:check in CI
npm run typecheck
```

## Testing

```bash
npm test          # starts a throwaway PostgreSQL automatically (or set TEST_DATABASE_URL)
npm run typecheck
```

The suite covers conditions (above/below/crosses/equals, jumps across the level), anti-repeat, re-arm, cooldown, expiry, paused alerts, duplicate/stale ticks, concurrent ticks (optimistic locking), multi-alert triggers, user isolation, Telegram delivery (success, outage + retry, invalid chat, invalid token without leaking it, idempotent processing, MarkdownV2 fallback, deleted bots), authentication, authorization, CSRF, API validation, secret handling and webhook authentication/idempotency.
