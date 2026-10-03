import { describe, expect, it } from "vitest";
import { conditionMet, evaluate, type AlertState } from "@/lib/engine/evaluate";

const T0 = new Date("2026-10-03T14:00:00Z");
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);

function state(over: Partial<AlertState> = {}): AlertState {
  return {
    conditionType: "PRICE_ABOVE",
    targetPrice: 3900,
    tolerance: 0,
    triggerMode: "REARM",
    cooldownSeconds: 0,
    expiryType: "NEVER",
    expiresAt: null,
    maxTriggers: null,
    triggerCount: 0,
    lastTriggeredAt: null,
    armed: true,
    lastPrice: null,
    status: "ACTIVE",
    ...over,
  };
}

/** Runs a price series through the evaluator and returns the indexes (and prices) that triggered. */
function run(s: AlertState, prices: number[], stepSec = 5) {
  let cur = { ...s };
  const fired: number[] = [];
  prices.forEach((p, i) => {
    const ev = evaluate(cur, p, at(i * stepSec));
    if (ev.trigger) fired.push(p);
    cur = { ...cur, ...ev.next };
  });
  return { fired, final: cur };
}

describe("conditions", () => {
  it("Above: price >= target", () => {
    expect(conditionMet("PRICE_ABOVE", 3900, null, 3900)).toBe(true);
    expect(conditionMet("PRICE_ABOVE", 3901, null, 3900)).toBe(true);
    expect(conditionMet("PRICE_ABOVE", 3899.99, null, 3900)).toBe(false);
  });

  it("Below: price <= target", () => {
    expect(conditionMet("PRICE_BELOW", 3900, null, 3900)).toBe(true);
    expect(conditionMet("PRICE_BELOW", 3899, null, 3900)).toBe(true);
    expect(conditionMet("PRICE_BELOW", 3900.01, null, 3900)).toBe(false);
  });

  it("Crosses Above: requires previous price below target", () => {
    expect(conditionMet("CROSSES_ABOVE", 3901, 3895, 3900)).toBe(true);
    expect(conditionMet("CROSSES_ABOVE", 3900, 3899.5, 3900)).toBe(true);
    expect(conditionMet("CROSSES_ABOVE", 3902, 3901, 3900)).toBe(false); // already above
    expect(conditionMet("CROSSES_ABOVE", 3901, null, 3900)).toBe(false); // no history
    expect(conditionMet("CROSSES_ABOVE", 3899, 3895, 3900)).toBe(false);
  });

  it("Crosses Below: requires previous price above target", () => {
    expect(conditionMet("CROSSES_BELOW", 3899, 3905, 3900)).toBe(true);
    expect(conditionMet("CROSSES_BELOW", 3898, 3899, 3900)).toBe(false);
    expect(conditionMet("CROSSES_BELOW", 3899, null, 3900)).toBe(false);
  });

  it("Equals: within tolerance", () => {
    expect(conditionMet("PRICE_EQUALS", 3900, null, 3900)).toBe(true);
    expect(conditionMet("PRICE_EQUALS", 3900.4, null, 3900, 0.5)).toBe(true);
    expect(conditionMet("PRICE_EQUALS", 3900.6, null, 3900, 0.5)).toBe(false);
    expect(conditionMet("PRICE_EQUALS", 1.1, null, 1.1)).toBe(true); // float-safe
  });

  it("detects price jumping straight across the target", () => {
    expect(conditionMet("CROSSES_ABOVE", 4100, 3700, 3900)).toBe(true);
    expect(conditionMet("CROSSES_BELOW", 3700, 4100, 3900)).toBe(true);
  });
});

describe("anti-repeat", () => {
  it("3895 → 3901 triggers once; staying above never re-sends (REARM)", () => {
    const { fired } = run(state(), [3895, 3901, 3901, 3901.5, 3902, 3950, 3901]);
    expect(fired).toEqual([3901]);
  });

  it("re-arms only after price returns below the target", () => {
    const { fired } = run(state(), [3895, 3901, 3901, 3895, 3902, 3903]);
    expect(fired).toEqual([3901, 3902]);
  });

  it("ONCE mode fires a single time and marks the alert TRIGGERED", () => {
    const { fired, final } = run(state({ triggerMode: "ONCE" }), [3895, 3901, 3895, 3902]);
    expect(fired).toEqual([3901]);
    expect(final.status).toBe("TRIGGERED");
  });

  it("duplicate price updates do not re-trigger", () => {
    const { fired } = run(state(), [3901, 3901, 3901, 3901]);
    expect(fired).toEqual([3901]);
  });

  it("rapid oscillation around the target is bounded by the cooldown", () => {
    const series = [3899, 3901, 3899, 3901, 3899, 3901, 3899, 3901];
    // 1s apart with a 60s cooldown → only the first crossing fires.
    expect(run(state({ cooldownSeconds: 60 }), series, 1).fired).toEqual([3901]);
    // without cooldown every re-armed crossing fires
    expect(run(state({ cooldownSeconds: 0 }), series, 1).fired).toHaveLength(4);
  });

  it("Crosses Above fires on each genuine crossing only", () => {
    const { fired } = run(state({ conditionType: "CROSSES_ABOVE" }), [3901, 3902, 3895, 3901, 3905, 3899, 3910]);
    expect(fired).toEqual([3901, 3910]);
  });

  it("EVERY_TIME fires whenever the condition holds, throttled by cooldown", () => {
    const s = state({ triggerMode: "EVERY_TIME", cooldownSeconds: 10 });
    // 5s steps: t=0 fire, t=5 cooldown, t=10 fire, t=15 cooldown, t=20 fire
    expect(run(s, [3901, 3901, 3901, 3901, 3901]).fired).toHaveLength(3);
  });
});

describe("cooldown", () => {
  it("suppresses triggers inside the cooldown window even after re-arm", () => {
    const { fired } = run(state({ cooldownSeconds: 30 }), [3895, 3901, 3895, 3902, 3895, 3895, 3895, 3903], 5);
    // t=5 fire; t=15 re-armed but within 30s; t=35 fire
    expect(fired).toEqual([3901, 3903]);
  });

  it("a crossing suppressed by the cooldown does not fire late once the cooldown ends", () => {
    // t=5 fire; t=10 below (re-arm); t=15 above inside cooldown → consumed; stays above afterwards → silent
    const { fired } = run(state({ cooldownSeconds: 30 }), [3895, 3901, 3895, 3902, 3903, 3904, 3905, 3906, 3907]);
    expect(fired).toEqual([3901]);
  });

  it("ONCE alerts are not consumed by the cooldown (they still fire after it)", () => {
    const ev = evaluate(state({ triggerMode: "ONCE", cooldownSeconds: 60, lastTriggeredAt: at(0) }), 3905, at(30));
    expect(ev.reason).toBe("cooldown");
    expect(ev.next.armed).toBe(true);
  });

  it("reports the cooldown reason", () => {
    const ev = evaluate(state({ cooldownSeconds: 60, lastTriggeredAt: at(0), armed: true }), 3905, at(30));
    expect(ev.trigger).toBe(false);
    expect(ev.reason).toBe("cooldown");
  });
});

describe("status and expiry", () => {
  it("paused alerts never trigger", () => {
    expect(evaluate(state({ status: "PAUSED" }), 4000).trigger).toBe(false);
  });

  it("expires at a specific date", () => {
    const ev = evaluate(state({ expiryType: "AT_DATE", expiresAt: at(-1) }), 4000, at(0));
    expect(ev.trigger).toBe(false);
    expect(ev.next.status).toBe("EXPIRED");
  });

  it("expires after the first trigger", () => {
    const ev = evaluate(state({ expiryType: "AFTER_FIRST_TRIGGER" }), 4000);
    expect(ev.trigger).toBe(true);
    expect(ev.next.status).toBe("EXPIRED");
  });

  it("expires after N triggers", () => {
    const { fired, final } = run(state({ expiryType: "AFTER_N_TRIGGERS", maxTriggers: 2 }), [3901, 3895, 3901, 3895, 3901]);
    expect(fired).toHaveLength(2);
    expect(final.status).toBe("EXPIRED");
  });
});
