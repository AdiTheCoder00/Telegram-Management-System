"use client";

import { conditionMet } from "@/lib/engine/evaluate";
import type { ConditionTypeT } from "@/lib/constants";
import { cn, formatPrice, signed } from "@/lib/utils";

function decimalsFor(n: number) {
  return Math.abs(n) < 10 ? 5 : Math.abs(n) < 100 ? 3 : 2;
}

/**
 * A vertical price ladder: the target is drawn as a dashed level line and the live price as a marker
 * that glides to its position on every update. Distance is "how far price still has to travel".
 */
export function LevelLadder({
  symbol,
  current,
  target,
  condition,
  tolerance,
  loading,
  error,
  updatedAt,
}: {
  symbol: string;
  current: number | null;
  target: number | null;
  condition: ConditionTypeT;
  tolerance: number;
  loading?: boolean;
  error?: string | null;
  updatedAt?: string | null;
}) {
  const hasBoth = current !== null && target !== null && target > 0;
  const d = decimalsFor(target || current || 100);
  const distance = hasBoth ? target! - current! : null;
  const pct = hasBoth ? (distance! / current!) * 100 : null;
  const metNow =
    hasBoth &&
    condition !== "CROSSES_ABOVE" &&
    condition !== "CROSSES_BELOW" &&
    conditionMet(condition, current!, null, target!, tolerance);

  // Scale: centre between both values, padded so neither sits on the edge.
  let top = 0;
  let bottom = 1;
  if (hasBoth) {
    const mid = (current! + target!) / 2;
    const half = Math.max(Math.abs(current! - target!) * 0.85, target! * 0.0015);
    top = mid + half;
    bottom = mid - half;
  }
  const pos = (v: number) => `${Math.min(96, Math.max(4, ((top - v) / (top - bottom)) * 100))}%`;
  const ticks = hasBoth ? Array.from({ length: 5 }, (_, i) => top - ((top - bottom) * (i + 0.5)) / 5) : [];

  return (
    <div className="rounded-xl border bg-card">
      <div className="flex items-baseline justify-between px-4 pt-4">
        <div className="text-[15px] font-semibold tracking-tight">{symbol || "Choose a symbol"}</div>
        <div className="text-xs text-muted-foreground">
          {loading ? "Updating…" : updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString()}` : ""}
        </div>
      </div>

      <div className="relative mx-4 mt-3 h-52 overflow-hidden rounded-lg bg-muted/50">
        {hasBoth ? (
          <>
            {ticks.map((t) => (
              <div key={t} className="absolute right-0 left-0 border-t border-border/70" style={{ top: pos(t) }}>
                <span className="absolute right-2 -translate-y-1/2 bg-transparent text-[10px] text-muted-foreground tabular">
                  {formatPrice(t, d)}
                </span>
              </div>
            ))}
            {/* Zone that satisfies the condition */}
            {(condition === "PRICE_ABOVE" || condition === "CROSSES_ABOVE") && (
              <div className="absolute right-0 left-0 bg-up/8" style={{ top: 0, height: pos(target!) }} />
            )}
            {(condition === "PRICE_BELOW" || condition === "CROSSES_BELOW") && (
              <div className="absolute right-0 bottom-0 left-0 bg-down/8" style={{ top: pos(target!) }} />
            )}
            <div className="absolute right-0 left-0 z-10 border-t-2 border-dashed border-signal" style={{ top: pos(target!) }}>
              <span className="absolute left-2 -translate-y-[calc(100%+3px)] rounded bg-signal px-1.5 py-0.5 text-[11px] font-semibold text-ink tabular">
                Target {formatPrice(target!, d)}
              </span>
            </div>
            <div
              className="absolute right-16 left-24 z-20 transition-[top] duration-700 ease-out motion-reduce:transition-none"
              style={{ top: pos(current!) }}
            >
              <div className="absolute right-0 left-0 border-t border-foreground/60" />
              <span className="absolute -top-1.5 -left-1.5 size-3 rounded-full bg-foreground ring-4 ring-foreground/15" />
              <span className="absolute -left-1 translate-y-1.5 rounded bg-foreground px-1.5 py-0.5 text-[11px] font-semibold text-background tabular">
                {formatPrice(current!, d)}
              </span>
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {error ?? (target ? "Waiting for the current price…" : "Enter a target price to see it against the market.")}
          </div>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-b-xl border-t bg-border">
        <Stat label="Current price" value={current !== null ? formatPrice(current, d) : "—"} />
        <Stat label="Target" value={target ? formatPrice(target, d) : "—"} />
        <Stat
          label="Distance"
          value={distance !== null ? signed(distance, d) : "—"}
          tone={distance === null ? undefined : distance >= 0 ? "up" : "down"}
        />
        <Stat
          label="Distance %"
          value={pct !== null ? `${signed(pct, 2)}%` : "—"}
          tone={pct === null ? undefined : pct >= 0 ? "up" : "down"}
        />
      </dl>
      {metNow && (
        <p className="border-t bg-signal-soft px-4 py-2 text-xs text-[#7a4f00] dark:text-signal">
          The condition is already true at the current price, so this alert will fire on the next price update after you save it.
        </p>
      )}
      {error && hasBoth && <p className="border-t px-4 py-2 text-xs text-muted-foreground">{error}</p>}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="bg-card px-4 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 text-[17px] font-semibold tabular", tone === "up" && "text-up", tone === "down" && "text-down")}>
        {value}
      </dd>
    </div>
  );
}
