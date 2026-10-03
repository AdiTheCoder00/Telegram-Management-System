# Alert engine

Two alert kinds share one trigger state machine.

| Kind         | Input                                         | Evaluated              | Module                                  |
| ------------ | --------------------------------------------- | ---------------------- | --------------------------------------- |
| `PRICE`      | price ticks (polled, webhook, simulator)      | on every accepted tick | `engine/engine.ts` → `processPriceTick` |
| `CONDITIONS` | validated candles via the market-data service | every worker cycle     | `engine/condition-engine.ts`            |

## Condition alerts

A condition tree (`src/lib/conditions/types.ts`) is a small AST:

- `group` (AND / OR), `not`
- `compare` — `left <op> right`; operands are a price field, an indicator (any timeframe), or a number;
  operators `> >= < <= ==` and `crosses_above` / `crosses_below`
- `pattern` — candle/volume patterns (engulfing, hammer, inside bar, higher high, volume increasing, …)
- `session` — Asia / London / New York (IANA time zones, DST-aware) or a custom window

Validation happens twice: the zod schema (structure) and `validateTree` (known indicators, parameter ranges,
unique ids, size and depth limits, no constant-vs-constant comparisons), plus provider capability checks
(timeframes the provider can serve, volume availability) before an alert can be saved or activated.

### Evaluation modes

- **CANDLE_CLOSE** (default): each closed base candle is evaluated exactly once, at its own close time —
  the same instant a backtest uses. If the worker fell behind, at most `MAX_CATCHUP_BARS` (3) missed candles
  are evaluated in order; older ones are skipped and the alert's note says so (no burst of stale messages).
- **EVERY_TICK**: the forming base candle is evaluated every cycle; at most one trigger per base candle per
  alert version (idempotency key). Other timeframes always use their last **closed** candle.

### Fixed windows (live == backtest)

EMA, RSI, ATR, MACD … depend on how much history seeds them. Every evaluation therefore uses exactly the
last `L` bars of each timeframe, `L = clamp(4 × largest warm-up, 3, 1000)` (`conditions/window.ts`). With
fewer bars the alert reports `INSUFFICIENT_HISTORY` instead of guessing.

### Data gating

The market-data service attaches a freshness state to every series. `STALE`, `NO_DATA` and `INVALID`
(future-dated) data never trigger; the alert's `marketDataState` and `lastEvaluationNote` explain why it is
waiting (visible on the dashboard live monitor and the alert's Debug page).

## The trigger state machine — `decide(state, signal, now, observed)`

`signal = { ready, met, reset }`:

- not live (paused, draft, triggered, expired, error) → no trigger
- expiry date passed → `EXPIRED`
- `REARM` and `reset` → re-arm
- not `ready` (warm-up / no previous price for a crossing) → wait
- not `met` → nothing
- `ONCE`/`REARM` and disarmed → nothing (already fired for this setup)
- inside cooldown → suppressed (`REARM`: the crossing is consumed, not deferred)
- otherwise **trigger**: count++, `ONCE` → `TRIGGERED`, expiry rules, cooldown → `COOLDOWN`

## Committing a trigger — `commitEvaluation()`

One transaction:

1. optimistic state update `WHERE version = <read version>` (a concurrent evaluation loses cleanly),
2. `AlertEvent` (with `alertVersion`),
3. `TriggerEvidence` — immutable, with a **unique idempotency key**
   (`alertId:v<configVersion>:symbol:timeframe:candleOpenTime:mode`, or `…:tick:<time>` for price alerts),
4. a `QUEUED` `TelegramDelivery` (outbox).

A duplicate key (retry, restart, second worker, re-sent webhook) aborts the whole transaction: no second event,
no second notification.

## Versioning

Every configuration change creates an immutable `AlertVersion` (v1 on create) and increments `configVersion`;
pause/resume and engine state do not. Events, evidence and backtests record the version they used, and changing
the conditions resets the candle cursor so the new tree starts cleanly.

## Explainability

History → **Why?** shows the stored evidence: the evaluation tree with every operand's value (and previous value
for crossings), the candle used, its state, market-data time, windows, data source, engine versions and the alert
version. The **Debug** page (`/alerts/<id>/debug`) dry-runs the live path at any moment without writing anything.
