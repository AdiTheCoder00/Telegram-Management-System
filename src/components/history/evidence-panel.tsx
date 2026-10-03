"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, errorMessage } from "@/lib/client-api";
import { EvaluationTree } from "@/components/evaluation-tree";
import type { NodeResult } from "@/lib/conditions/evaluate";
import { formatPrice } from "@/lib/utils";

interface EvidenceResponse {
  event: { id: string; triggeredAt: string; triggerPrice: number; isTest: boolean; alertVersion: number | null };
  evidence: {
    reason: string;
    provider: string;
    timeframe: string | null;
    evaluationMode: string;
    candleOpenTime: string | null;
    candleState: string | null;
    price: number;
    marketDataTime: string | null;
    providerMeta: Record<string, unknown> | null;
    evaluation: {
      tree?: NodeResult;
      type?: string;
      label?: string;
      windows?: Record<string, { from: number; to: number; bars: number }>;
    } & Record<string, unknown>;
    evaluationEngineVersion: string;
    indicatorEngineVersion: string;
    idempotencyKey: string;
    alertVersion: number;
    createdAt: string;
  } | null;
  config: Record<string, unknown> | null;
}

const iso = (s: string | null | undefined) => (s ? new Date(s).toISOString().replace("T", " ").replace(".000Z", "Z") : "—");

/** "Why did this alert trigger?" — loads the immutable trigger evidence for one history event. */
export function EvidencePanel({ eventId }: { eventId: string }) {
  const [data, setData] = useState<EvidenceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    api<EvidenceResponse>(`/api/history/${eventId}/evidence`, { signal: ctrl.signal })
      .then(setData)
      .catch((err) => {
        if ((err as Error).name !== "AbortError") setError(errorMessage(err));
      });
    return () => ctrl.abort();
  }, [eventId]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!data)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading evidence…
      </p>
    );
  const ev = data.evidence;
  if (!ev)
    return (
      <p className="text-sm text-muted-foreground">
        {data.event.isTest
          ? "Test messages are not real triggers, so there is no evidence."
          : "This trigger was recorded before evidence capture existed (or by an older engine version)."}
      </p>
    );

  return (
    <div className="grid gap-5 py-1 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0">
        <div className="mb-1 text-xs text-muted-foreground">Why it triggered</div>
        <p className="mb-3 text-sm font-medium">{ev.reason}</p>
        {ev.evaluation.tree ? (
          <EvaluationTree node={ev.evaluation.tree} />
        ) : (
          <p className="text-sm">
            {String(ev.evaluation.label ?? "")} — price {formatPrice(ev.price)}
          </p>
        )}
      </div>
      <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-muted-foreground">Data source</dt>
        <dd>{ev.provider}</dd>
        <dt className="text-muted-foreground">Timeframe</dt>
        <dd>{ev.timeframe ?? "tick"}</dd>
        <dt className="text-muted-foreground">Mode</dt>
        <dd>{ev.evaluationMode === "CANDLE_CLOSE" ? "Candle close" : "Every tick / intrabar"}</dd>
        <dt className="text-muted-foreground">Candle (open, UTC)</dt>
        <dd className="tabular">
          {iso(ev.candleOpenTime)} {ev.candleState && <span className="text-muted-foreground">({ev.candleState.toLowerCase()})</span>}
        </dd>
        <dt className="text-muted-foreground">Price used</dt>
        <dd className="tabular">{formatPrice(ev.price)}</dd>
        <dt className="text-muted-foreground">Market data time</dt>
        <dd className="tabular">{iso(ev.marketDataTime)}</dd>
        <dt className="text-muted-foreground">Evaluated at</dt>
        <dd className="tabular">{iso(ev.createdAt)}</dd>
        {ev.evaluation.windows && (
          <>
            <dt className="text-muted-foreground">Windows</dt>
            <dd className="tabular">
              {Object.entries(ev.evaluation.windows)
                .map(([tf, w]) => `${tf}: ${w.bars} bars`)
                .join(", ")}
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">Alert version</dt>
        <dd>v{ev.alertVersion}</dd>
        <dt className="text-muted-foreground">Engines</dt>
        <dd>
          evaluation {ev.evaluationEngineVersion} · indicators {ev.indicatorEngineVersion}
        </dd>
        <dt className="text-muted-foreground">Idempotency key</dt>
        <dd className="break-all font-mono text-[11px] text-muted-foreground">{ev.idempotencyKey}</dd>
      </dl>
    </div>
  );
}
