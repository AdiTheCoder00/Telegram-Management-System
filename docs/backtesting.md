# Backtesting

**Backtest** replays an indicator-condition alert over history with the live engine's own code.

## What is replayed

For every closed base candle in `[from, to)`, in time order, at that candle's close:

1. fixed `L`-bar windows for every timeframe (`buildWindowContext`) — only candles that existed at that instant,
2. `evaluateConditions` (same evaluator, same indicators),
3. `decide()` — the same once / re-arm / every-time and cooldown state machine.

A test (`tests/backtest.integration.test.ts`) steps the **live** condition engine bar by bar on the deterministic
mock provider and asserts it triggers on exactly the same candles, at the same prices, as the backtest.

EVERY_TICK alerts cannot be reproduced from candles (the intrabar path is unknown). They are replayed at
candle close and the result is flagged "intrabar approximated".

## Results

- Triggers, bars evaluated / skipped for insufficient history, bars where the condition was true, and how many
  triggers the cooldown or re-arm rule suppressed.
- **Forward moves** after each trigger at chosen horizons (bars): average, median, % positive.
- **MFE / MAE** over the longest horizon, direction-aware (long: up is favourable; short: down).
- Per-trigger evidence: values of every operand and the full evaluation tree; a candlestick chart with markers.

Forward statistics are measured strictly after the decision and never influence it.

## Reproducibility

Each run stores: the configuration snapshot (incl. alert id and **alert version**), the **engine versions**
(backtest, evaluation, indicators) and the **dataset identity** — provider, per-timeframe source, candle counts,
first/last candle, data-issue counts and a **SHA-256** of the exact candles used. Same data + same engines ⇒ same
hash ⇒ same result (tested).

## Data

The history loader (`src/lib/backtest/history.ts`) uses the same sources as live data: provider pages of up to
5000 bars (cached in the database; later runs read the cache), aggregation from lower timeframes, or pushed /
tick candles for webhook feeds. Warm-up history before `from` is loaded automatically. Data issues are reported,
not repaired. Twelve Data's request budget is respected (the job waits rather than fails).

Synthetic (mock) data is labelled as such in results: it checks your logic, it says nothing about real markets.

## Jobs and limits

Runs are queued (`QUEUED → RUNNING → COMPLETED | FAILED | CANCELLED`) and executed by the worker one at a time,
claimed with `FOR UPDATE SKIP LOCKED`. Progress updates every second; queued runs can be cancelled, running ones
stop at the next checkpoint. At most 3 queued/running per user, 50 000 base bars per run, 100 000 bars per
timeframe. A run interrupted by a worker restart is marked FAILED — just run it again.
