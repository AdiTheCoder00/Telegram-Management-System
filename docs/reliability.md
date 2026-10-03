# Reliability

## Exactly-once triggers, at-least-once delivery

- **Triggers** are protected by the evidence idempotency key (unique index) and optimistic version checks. Retried
  ticks, re-sent webhooks, worker restarts and a second worker cannot create a second event.
- **Notifications** use a transactional outbox: the `TelegramDelivery` row is written in the same transaction as
  the event. Delivery is at-least-once: `QUEUED → SENDING → SENT | RETRYING | FAILED | DEAD_LETTER`.
  - A delivery is claimed (`SENDING` with a lock lease); a crashed sender's lease expires and it is retried.
  - Retries use exponential backoff and honour Telegram's `retry_after` (429).
  - Permanent errors (bad token, bot blocked, chat not found, bot's own chat) fail immediately with a
    readable reason; transient ones become `DEAD_LETTER` after `TELEGRAM_MAX_RETRIES` attempts.
  - Group → supergroup chat migrations are followed automatically and saved on the bot.
- **Retry failed notifications** (System page) re-queues FAILED and DEAD_LETTER deliveries from the last 7 days.

## Market data failures

- A provider error never triggers anything; cached candles are served with `providerError`, and freshness rules
  still apply. Provider health (last success/error, consecutive failures) is on the System page.
- Stale/invalid/missing data puts condition alerts into a visible waiting state.
- After an outage, CANDLE_CLOSE alerts catch up at most 3 missed candles; anything older is skipped with a note.
- **Reconnect market data** clears failure counters and request budgets and runs a poll cycle immediately.

## Worker

- Heartbeat every 10 s; the dashboard and System page show it. No heartbeat for 30 s ⇒ "worker not running".
- Periodic jobs never overlap themselves. Backtests run one at a time; interrupted runs are marked FAILED.
- Without Redis the database outbox is the queue. With Redis (BullMQ), the outbox sweep remains as a safety net.

## Emergency controls (System page, all audited)

- **Pause all** — every live alert is paused and marked; **Resume all** restores exactly those (each through the
  activation checks). Pausing or resuming an alert by hand removes it from the bulk set.
- Every operational action is written to the audit log.

## Backups

```bash
npm run db:backup                  # backups/levels-<timestamp>.json.gz (all tables)
npm run db:backup -- --no-candles  # smaller: skip cached/tick candles (re-fetchable)
npm run db:restore -- backups/levels-<timestamp>.json.gz
```

Logical backups (`row_to_json` / `json_populate_recordset`) — no pg_dump needed; types round-trip exactly; a
restore runs in one transaction (all or nothing) after a typed confirmation. Apply migrations first
(`npm run db:deploy`) when restoring into an empty database. Keep `ENCRYPTION_KEY` with your backups: bot tokens
are stored encrypted and cannot be read without it. `/backups` is git-ignored.

For managed PostgreSQL, the provider's point-in-time recovery or `pg_dump --format=custom` are good complements.
