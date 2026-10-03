# Architecture

Levels is a personal trading-alert and backtesting platform: one owner, one web app, one background worker,
one PostgreSQL database (Redis optional).

```
                 ┌──────────────────────────── Next.js web app ────────────────────────────┐
 Browser ──────▶ │ pages (App Router)   API routes (/api/*)   SSE (/api/stream)            │
                 │      │                    │                                             │
                 │      └──── services (src/lib/services/*) ──── shared engine core ──────┐ │
                 └──────────────────────────────────────────────────────────────────────┘ │
 TradingView ──▶ /api/webhooks/tradingview/<secret>, /api/webhooks/<id>  ── ticks / bars ─┤
                                                                                          ▼
                 ┌──────────────────────────── worker (src/worker) ────────────────────────┐
                 │ every PRICE_POLL_INTERVAL_MS: expire → release cooldowns → poll prices   │
                 │   → price alerts (ticks) → condition alerts (candles) → outbox           │
                 │ every 1 s: deliver due notifications (outbox) · every 2 s: backtests     │
                 │ hourly: prune candles, purge sessions · heartbeat every 10 s             │
                 └──────────────────────────────────────────────────────────────────────────┘
                                   │                         │
                         PostgreSQL (all state)       Telegram Bot API
```

## Shared engine core (the same code live, in the simulator and in backtests)

| Layer | Module | Responsibility |
| --- | --- | --- |
| Market data | `src/lib/market/service.ts` | The **only** way engines get candles: provider → cache → aggregation / ticks / pushed bars → `normalizeCandles` → freshness |
| Candles | `src/lib/market/candles.ts`, `timeframes.ts` | Canonical candle, UTC buckets, validation, aggregation (no look-ahead) |
| Indicators | `src/lib/indicators/*` | 21 causal indicators, explicit warm-ups, `INDICATOR_ENGINE_VERSION` |
| Conditions | `src/lib/conditions/*` | Condition AST, schema + semantic validation, explainable evaluation, fixed windows |
| Trigger state machine | `src/lib/engine/evaluate.ts` → `decide()` | Once / re-arm / every-time, cooldown, expiry, terminal states |
| Live engines | `src/lib/engine/engine.ts` (price ticks), `condition-engine.ts` (candles) | Evaluate, then `commitEvaluation()` atomically |
| Notifications | `src/lib/notifications/*` | Outbox, provider interface, retries, dead letter |
| Backtests | `src/lib/backtest/*` | History loader + pure replay through the same windows/evaluator/`decide()` |

## Persistence

All timestamps are `timestamptz` and Prisma sessions run in UTC. Key tables:

- `Alert` (+ `AlertVersion` immutable config snapshots, `configVersion`), `AlertGroup`
- `AlertEvent` (history) + `TriggerEvidence` (immutable "why", unique idempotency key) + `TelegramDelivery` (outbox)
- `Candle` (provider cache, user-pushed bars, 1m tick candles), `Quote`, `ProviderHealth`
- `Backtest` (config snapshot, dataset hash, engine versions, result), `Webhook`, `AuditLog`, `WorkerHeartbeat`

## Process model

- **Web** (`npm run dev` / `npm start`): UI, API, webhooks, SSE. Local mode binds to 127.0.0.1 only.
- **Worker** (`npm run worker`): everything time-driven. Without Redis it uses the database outbox; with
  `REDIS_URL` it uses BullMQ queues (the outbox sweep still runs as a safety net).
- Restart **both** after `prisma migrate` (each holds a generated Prisma client).

See [alert-engine.md](alert-engine.md), [market-data.md](market-data.md), [candle-semantics.md](candle-semantics.md),
[backtesting.md](backtesting.md), [reliability.md](reliability.md), [deployment.md](deployment.md),
[troubleshooting.md](troubleshooting.md).
