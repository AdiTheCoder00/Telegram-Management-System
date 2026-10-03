/**
 * Market sessions (M12). Timestamps are UTC epoch ms; sessions are defined in their own local time zone,
 * so daylight-saving shifts are handled by the IANA tz database (via Intl), not by fixed UTC offsets.
 *
 * Built-in sessions (local exchange hours):
 *   ASIA      09:00–18:00 Asia/Tokyo         (Tokyo has no DST)
 *   LONDON    08:00–17:00 Europe/London      (moves with BST)
 *   NEW_YORK  08:00–17:00 America/New_York   (moves with EDT)
 * Custom sessions: any IANA zone, start/end "HH:MM", trading days (1 = Monday … 7 = Sunday).
 * A session whose end is earlier than its start runs overnight; the trading day is the day it STARTED.
 */
export const BUILTIN_SESSIONS = ["ASIA", "LONDON", "NEW_YORK"] as const;
export type BuiltinSession = (typeof BUILTIN_SESSIONS)[number];

export interface SessionDef {
  name: string;
  timezone: string;
  start: string; // "HH:MM"
  end: string; // "HH:MM" (exclusive)
  days: number[]; // ISO weekday 1..7
}

const WEEKDAYS = [1, 2, 3, 4, 5];

export const SESSION_DEFS: Record<BuiltinSession, SessionDef> = {
  ASIA: { name: "Asian (Tokyo)", timezone: "Asia/Tokyo", start: "09:00", end: "18:00", days: WEEKDAYS },
  LONDON: { name: "London", timezone: "Europe/London", start: "08:00", end: "17:00", days: WEEKDAYS },
  NEW_YORK: { name: "New York", timezone: "America/New_York", start: "08:00", end: "17:00", days: WEEKDAYS },
};

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", weekday: "short", hour: "2-digit", minute: "2-digit" });
    fmtCache.set(tz, f);
  }
  return f;
}

const DOW: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Local weekday (1..7) and minute-of-day for an instant in a time zone. */
export function localTime(t: number, tz: string) {
  const parts = Object.fromEntries(
    formatter(tz)
      .formatToParts(new Date(t))
      .map((p) => [p.type, p.value]),
  );
  return { weekday: DOW[parts.weekday], minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

function toMinutes(hhmm: string) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) throw new Error(`Invalid time "${hhmm}" (expected HH:MM)`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function validateSession(def: SessionDef) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: def.timezone });
  } catch {
    throw new Error(`Unknown time zone "${def.timezone}"`);
  }
  if (toMinutes(def.start) === toMinutes(def.end)) throw new Error("Session start and end must differ");
  if (!def.days.length || def.days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) throw new Error("Trading days must be 1–7");
}

/** Is instant `t` inside the session? */
export function inSession(t: number, def: SessionDef): boolean {
  const { weekday, minute } = localTime(t, def.timezone);
  const s = toMinutes(def.start);
  const e = toMinutes(def.end);
  if (s < e) return minute >= s && minute < e && def.days.includes(weekday);
  // Overnight: the evening part belongs to today, the early-morning part to yesterday's session.
  if (minute >= s) return def.days.includes(weekday);
  if (minute < e) return def.days.includes(weekday === 1 ? 7 : weekday - 1);
  return false;
}

export function resolveSession(s: BuiltinSession | SessionDef): SessionDef {
  return typeof s === "string" ? SESSION_DEFS[s] : s;
}

/** Which built-in sessions are open at `t` (sessions overlap, e.g. London/New York). */
export function activeSessions(t: number): BuiltinSession[] {
  return BUILTIN_SESSIONS.filter((k) => inSession(t, SESSION_DEFS[k]));
}
