# Candle semantics

These rules are what make live alerts, the debugger and backtests agree.

## The canonical candle

```text
{ openTime, closeTime, open, high, low, close, volume | null, volumeType, state }
```

- `openTime` is **inclusive**, `closeTime` is **exclusive**: the candle covers `[openTime, closeTime)`.
- All times are UTC epoch milliseconds. Display converts to your timezone; buckets never do.
- `state`: `FORMING` (`closeTime > asOf`), `CLOSED` (`closeTime <= asOf`), `INVALID` (failed validation).
- `volumeType`: `REAL` (exchange volume), `PROVIDER` (vendor volume, e.g. FX tick volume), `TICK` (number of
  price updates we received), `UNAVAILABLE` (null). Volume conditions are refused for providers without volume.

## Timeframe buckets

`1m 3m 5m 15m 30m 1h 2h 4h 1d` are fixed-length UTC buckets aligned to the Unix epoch. `1w` starts **Monday
00:00 UTC**; `1M` is the calendar month in UTC. A "4h" candle is therefore 00–04, 04–08 … UTC, not shifted to
an exchange's session.

## Which candle is "current"

At an evaluation instant `asOf`:

| Timeframe | CANDLE_CLOSE                                 | EVERY_TICK                                  |
| --------- | -------------------------------------------- | ------------------------------------------- |
| base      | last **closed** candle (`closeTime <= asOf`) | the **forming** candle (`openTime <= asOf`) |
| any other | last **closed** candle                       | last **closed** candle                      |

A 1h EMA used by a 5m alert at 10:07 uses the 09:00–10:00 candle, never the forming 10:00 candle. This is the
no-look-ahead guarantee; it is property-tested for every indicator.

## Crossings

`A crosses_above B` means `A[prev] <= B[prev]` and `A[now] > B[now]` on the operand's own timeframe bars.
A crossing needs a previous value; during warm-up it is "not ready" (never a trigger).

## Aggregation

Higher timeframes are built from lower closed candles only (`aggregate`): open = first open, close = last close,
high/low = extremes, volume = sum (null if any part lacks volume). A bucket is emitted only when complete and
closed at `asOf`; partial buckets are never presented as closed.

## Validation (`normalizeCandles`)

Reports — and never "fixes" — `duplicate`, `out_of_order`, `gap`, `invalid_ohlc` (high < max(open, close),
negative volume, …), `misaligned` (open time not on a bucket boundary), `future` and `non_finite`. Future-dated
data makes the whole series `INVALID` for triggering.

## Sessions

Session filters use IANA time zones (DST handled by the zone database). An overnight session belongs to the
day it **starts**. Built-ins: Asia (Tokyo 09:00–15:00), London (08:00–16:30), New York (09:30–16:00), local times.
