"use client";

import { useState } from "react";
import { Bug, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EvaluationTree } from "@/components/evaluation-tree";
import { api, errorMessage } from "@/lib/client-api";
import type { DebugResult } from "@/lib/services/debugger";
import { cn } from "@/lib/utils";

type Json<T> = T extends Date ? string : T extends (infer U)[] ? Json<U>[] : T extends object ? { [K in keyof T]: Json<T[K]> } : T;

const FRESH_TONE: Record<string, string> = {
  LIVE: "text-up",
  FRESH: "text-up",
  STALE: "text-signal",
  NO_DATA: "text-muted-foreground",
  INVALID: "text-down",
};

/**
 * Dry-runs conditions through the live engine (market data → windows → conditions → state machine) at "now" or
 * any past instant. Nothing is saved or sent.
 */
export function ConditionDebugger({ body, compact = false }: { body: () => Record<string, unknown> | null; compact?: boolean }) {
  const [asOf, setAsOf] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Json<DebugResult> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    const b = body();
    if (!b) return setError("Add at least one valid condition first.");
    setLoading(true);
    setError(null);
    try {
      setResult(
        await api<Json<DebugResult>>("/api/debug", {
          method: "POST",
          body: { ...b, ...(asOf ? { asOf: new Date(asOf).toISOString() } : {}) },
        }),
      );
    } catch (err) {
      setResult(null);
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label htmlFor="dbg-asof" className="text-xs">
            Evaluate at (blank = now)
          </Label>
          <Input id="dbg-asof" type="datetime-local" className="mt-1 h-8 w-56" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </div>
        <Button type="button" size="sm" variant="outline" onClick={run} disabled={loading}>
          {loading ? <Loader2 className="animate-spin" /> : <Bug />} Evaluate {asOf ? "at that time" : "now"}
        </Button>
        <span className="text-xs text-muted-foreground">Dry run — nothing is saved or sent.</span>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {result && (
        <div className="space-y-4 rounded-lg border p-4">
          {result.decision ? (
            <p className={cn("text-sm font-medium", result.decision.trigger ? "text-up" : "text-foreground")}>{result.decision.text}</p>
          ) : result.evaluation ? (
            <p className={cn("text-sm font-medium", result.evaluation.result ? "text-up" : "text-foreground")}>
              {result.evaluation.result ? "Conditions are satisfied." : "Conditions are not satisfied."}
              {result.blocked && <span className="block font-normal text-signal">{result.blocked}</span>}
            </p>
          ) : null}
          {!result.evaluation && result.insufficient.length > 0 && (
            <p className="text-sm text-signal">
              Not enough history: {result.insufficient.map((i) => `${i.timeframe} ${i.have}/${i.need} bars`).join(", ")}. The live engine
              waits instead of guessing.
            </p>
          )}

          {result.evaluation && (
            <div>
              <div className="mb-1 text-xs text-muted-foreground">
                Evaluated at {result.evaluatedAt.replace("T", " ").replace(".000Z", " UTC")}
                {result.evaluation.baseCandle &&
                  ` · ${result.config.timeframe} candle ${result.evaluation.baseCandle.openTime.slice(11, 16)} UTC (${result.evaluation.baseCandle.state.toLowerCase()})`}
              </div>
              <EvaluationTree node={result.evaluation.tree} />
            </div>
          )}

          {!compact && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1 pr-3 font-medium">Timeframe</th>
                    <th className="py-1 pr-3 font-medium">Source</th>
                    <th className="py-1 pr-3 font-medium">Freshness</th>
                    <th className="py-1 pr-3 font-medium">Window</th>
                    <th className="py-1 pr-3 font-medium">Last close</th>
                    <th className="py-1 font-medium">Data issues</th>
                  </tr>
                </thead>
                <tbody className="tabular">
                  {result.data.map((d) => {
                    const row = d as {
                      timeframe: string;
                      source?: string;
                      freshness?: string;
                      need: number;
                      error?: string;
                      issues?: unknown[];
                      lastBars?: { close: number }[];
                    };
                    const w = result.windows[row.timeframe as keyof typeof result.windows] as { bars: number } | undefined;
                    return (
                      <tr key={row.timeframe} className="border-t">
                        <td className="py-1 pr-3 font-medium">{row.timeframe}</td>
                        <td className="py-1 pr-3">{row.error ? <span className="text-destructive">{row.error}</span> : row.source}</td>
                        <td className={cn("py-1 pr-3", FRESH_TONE[row.freshness ?? ""])}>{row.freshness ?? "—"}</td>
                        <td className="py-1 pr-3">
                          {w ? w.bars : 0}/{row.need} bars
                        </td>
                        <td className="py-1 pr-3">{row.lastBars?.at(-1)?.close ?? "—"}</td>
                        <td className="py-1">{row.issues?.length ? `${row.issues.length}` : "none"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
