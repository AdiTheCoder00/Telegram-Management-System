import type { AlertStatusT, ConditionTypeT, ExpiryTypeT, TriggerModeT } from "@/lib/constants";

/**
 * Pure, side-effect-free alert evaluation. Given the alert's current state and a new price, decides whether
 * to trigger and what the next state is. All anti-spam logic lives here so it can be unit tested exhaustively.
 *
 * Anti-repeat model:
 *  - `armed` starts true. A trigger disarms the alert (ONCE / REARM).
 *  - REARM: the alert re-arms only once price returns to the *other side* of the target
 *    (e.g. for "Above 3900": price < 3900). Staying above never re-sends.
 *  - EVERY_TIME: fires whenever the condition holds, throttled by the cooldown.
 *  - Cooldown applies to every mode: no trigger within `cooldownSeconds` of the last one. For REARM a
 *    crossing that lands inside the cooldown is consumed (no late notification when the cooldown ends).
 *  - Crosses: require the previous observed price on the opposite side (prev < target ≤ price).
 *    Large jumps straight across the target are therefore detected; the first ever tick never "crosses".
 */

export interface AlertState {
  conditionType: ConditionTypeT;
  targetPrice: number;
  tolerance: number;
  triggerMode: TriggerModeT;
  cooldownSeconds: number;
  expiryType: ExpiryTypeT;
  expiresAt: Date | null;
  maxTriggers: number | null;
  triggerCount: number;
  lastTriggeredAt: Date | null;
  armed: boolean;
  lastPrice: number | null;
  status: AlertStatusT;
}

export type Reason = "triggered" | "not_active" | "expired" | "condition_not_met" | "disarmed" | "cooldown" | "no_previous_price";

export interface Evaluation {
  trigger: boolean;
  reason: Reason;
  next: Pick<AlertState, "armed" | "lastPrice" | "triggerCount" | "lastTriggeredAt" | "status">;
}

const EPS = 1e-9;

export function conditionMet(type: ConditionTypeT, price: number, prev: number | null, target: number, tolerance = 0): boolean {
  switch (type) {
    case "PRICE_ABOVE":
      return price >= target - EPS;
    case "PRICE_BELOW":
      return price <= target + EPS;
    case "CROSSES_ABOVE":
      return prev !== null && prev < target - EPS && price >= target - EPS;
    case "CROSSES_BELOW":
      return prev !== null && prev > target + EPS && price <= target + EPS;
    case "PRICE_EQUALS":
      return Math.abs(price - target) <= Math.max(tolerance, EPS);
  }
}

/** True when price is back on the "untriggered" side — used to re-arm REARM alerts. */
export function resetConditionMet(type: ConditionTypeT, price: number, target: number, tolerance = 0): boolean {
  switch (type) {
    case "PRICE_ABOVE":
    case "CROSSES_ABOVE":
      return price < target - EPS;
    case "PRICE_BELOW":
    case "CROSSES_BELOW":
      return price > target + EPS;
    case "PRICE_EQUALS":
      return Math.abs(price - target) > Math.max(tolerance, EPS);
  }
}

export function isExpiredByDate(s: Pick<AlertState, "expiryType" | "expiresAt">, now: Date) {
  return s.expiryType === "AT_DATE" && !!s.expiresAt && s.expiresAt.getTime() <= now.getTime();
}

export function evaluate(state: AlertState, price: number, now: Date = new Date()): Evaluation {
  const base = {
    armed: state.armed,
    lastPrice: price,
    triggerCount: state.triggerCount,
    lastTriggeredAt: state.lastTriggeredAt,
    status: state.status,
  };

  if (state.status !== "ACTIVE") return { trigger: false, reason: "not_active", next: { ...base, lastPrice: state.lastPrice } };

  if (isExpiredByDate(state, now)) return { trigger: false, reason: "expired", next: { ...base, status: "EXPIRED" } };

  // Re-arm when price has returned to the other side of the target.
  if (!base.armed && state.triggerMode === "REARM" && resetConditionMet(state.conditionType, price, state.targetPrice, state.tolerance)) {
    base.armed = true;
  }

  const isCross = state.conditionType === "CROSSES_ABOVE" || state.conditionType === "CROSSES_BELOW";
  if (isCross && state.lastPrice === null) return { trigger: false, reason: "no_previous_price", next: base };

  if (!conditionMet(state.conditionType, price, state.lastPrice, state.targetPrice, state.tolerance))
    return { trigger: false, reason: "condition_not_met", next: base };

  if (state.triggerMode !== "EVERY_TIME" && !base.armed) return { trigger: false, reason: "disarmed", next: base };

  if (
    state.cooldownSeconds > 0 &&
    state.lastTriggeredAt &&
    now.getTime() - state.lastTriggeredAt.getTime() < state.cooldownSeconds * 1000
  ) {
    // REARM: a crossing inside the cooldown is consumed, not deferred — otherwise the alert would fire
    // late (when the cooldown ends) about a move that happened earlier. It re-arms on the next return.
    if (state.triggerMode === "REARM") base.armed = false;
    return { trigger: false, reason: "cooldown", next: base };
  }

  // ── Trigger ──
  const triggerCount = state.triggerCount + 1;
  let status: AlertStatusT = "ACTIVE";
  if (state.triggerMode === "ONCE") status = "TRIGGERED";
  if (state.expiryType === "AFTER_FIRST_TRIGGER") status = "EXPIRED";
  if (state.expiryType === "AFTER_N_TRIGGERS" && state.maxTriggers && triggerCount >= state.maxTriggers) status = "EXPIRED";

  return {
    trigger: true,
    reason: "triggered",
    next: {
      armed: state.triggerMode === "EVERY_TIME",
      lastPrice: price,
      triggerCount,
      lastTriggeredAt: now,
      status,
    },
  };
}
