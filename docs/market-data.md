# Market data

Engines never talk to providers. They call the market-data service (`src/lib/market/service.ts`):

```
getSeries({ provider, symbol, timeframe, asOf, bars, scope? })
  → { candles, issues, freshness, source, providerError? }
```

## Providers and capabilities

| Key                        | Live data | Native candles                           | History              | Volume                        | Notes                                                                                                               |
| -------------------------- | --------- | ---------------------------------------- | -------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `mock` (alias `simulated`) | polling   | 1m–1M                                    | 10 years (generated) | REAL (synthetic)              | Deterministic: price = f(symbol, time). Always reported as **SIMULATED**.                                           |
| `twelvedata`               | polling   | 1m, 5m, 15m, 30m, 1h, 2h, 4h, 1d, 1w, 1M | ~10 years            | PROVIDER (or UNAVAILABLE)     | Needs `TWELVE_DATA_API_KEY`; request budget `TWELVE_DATA_RATE_LIMIT_PER_MIN` (default 8). 3m is aggregated from 1m. |
| `binance`                  | polling   | —                                        | —                    | TICK                          | Prices only; candles built from ticks.                                                                              |
| `custom`                   | polling   | —                                        | —                    | TICK                          | Any JSON price URL (`CUSTOM_PRICE_URL`).                                                                            |
| `webhook`                  | push      | pushed bars                              | what you pushed      | PROVIDER / UNAVAILABLE / TICK | TradingView or scripts; per-user scope.                                                                             |

Capabilities are checked when an alert is saved/activated and when a backtest is created.

## How a series is built

1. **Native timeframe** → DB cache (`Candle`, scope `global`), fetching only what's missing; served from cache
   when the provider fails (`providerError` is reported, freshness still applies).
2. **Other timeframe** → highest native lower timeframe, then `aggregate()` (only complete, closed buckets).
3. **No candle API** → user-pushed bars for exactly that timeframe, else 1m **tick candles** built from every
   accepted price tick, aggregated up.
4. Always: `normalizeCandles` (ordering, duplicates, OHLC sanity, alignment, future timestamps) — problems are
   reported as `issues`, never silently repaired.

## Freshness

`computeFreshness` judges the latest closed candle against the bucket that should have closed by `asOf`:

| State     | Meaning                                                                                      |
| --------- | -------------------------------------------------------------------------------------------- |
| `LIVE`    | up to date and the current (forming) candle is present                                       |
| `FRESH`   | up to date                                                                                   |
| `STALE`   | the next closed candle is overdue by more than `MARKET_DATA_CANDLE_GRACE_MS` (default 2 min) |
| `NO_DATA` | nothing to evaluate                                                                          |
| `INVALID` | provider returned future-dated candles                                                       |

Closed markets (weekends, holidays) are correctly `STALE`: there is nothing new to act on.

## Webhooks (TradingView)

Create a webhook under **Settings → Webhooks**. TradingView cannot send headers, so its secret is part of the URL:
`POST /api/webhooks/tradingview/<secret>`. Generic sources use `POST /api/webhooks/<id>` with `X-Webhook-Secret`.

Bar payload (recommended, alert "Once per bar close"):

```json
{"symbol":"{{ticker}}","interval":"{{interval}}","time":"{{time}}","open":{{open}},"high":{{high}},"low":{{low}},"close":{{close}},"volume":{{volume}}}
```

Tick payload: `{"symbol":"{{ticker}}","price":{{close}},"timestamp":"{{timenow}}"}`. Exchange prefixes
(`OANDA:XAUUSD`) are stripped. Limits: 64 KB, 100 items. Re-sent bars are ignored (keyed by symbol, interval
and bar time); add `"id"` to de-duplicate ticks. Secrets are shown once and stored as SHA-256.

A locally-run app is bound to 127.0.0.1 — TradingView needs a public URL (deployment or a tunnel).

## Retention

The worker prunes tick candles older than 30 days and cached provider candles older than 400 days (hourly).
