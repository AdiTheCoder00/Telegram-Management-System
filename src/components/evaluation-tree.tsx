import { Check, Minus, X } from "lucide-react";
import type { NodeResult, OperandTrace } from "@/lib/conditions/evaluate";
import { cn } from "@/lib/utils";

/** Renders an evaluation trace (trigger evidence, simulator, backtest trades) as an indented, explainable tree. */
export function EvaluationTree({ node, depth = 0 }: { node: NodeResult; depth?: number }) {
  const Icon = node.result === true ? Check : node.result === false ? X : Minus;
  return (
    <div className={cn(depth > 0 && "border-l pl-3")}>
      <div className="flex items-start gap-2 py-1">
        <Icon
          aria-label={node.result === true ? "true" : node.result === false ? "false" : "not evaluable"}
          className={cn(
            "mt-0.5 size-4 shrink-0",
            node.result === true ? "text-up" : node.result === false ? "text-down" : "text-muted-foreground",
          )}
        />
        <div className="min-w-0 text-sm">
          <div className="font-medium">{node.label}</div>
          {(node.left || node.right) && (
            <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground tabular">
              {node.left && <Trace t={node.left} />}
              {node.right && <Trace t={node.right} />}
            </div>
          )}
          {node.reason && node.result === null && <div className="text-xs text-muted-foreground">{node.reason}</div>}
        </div>
      </div>
      {node.children?.map((c) => (
        <EvaluationTree key={c.id} node={c} depth={depth + 1} />
      ))}
    </div>
  );
}

function fmt(v: number | null | undefined) {
  if (v === null || v === undefined) return "n/a";
  return Number(v.toFixed(Math.abs(v) < 10 ? 5 : 2)).toString();
}

function Trace({ t }: { t: OperandTrace }) {
  return (
    <span title={t.candleTime ? `${t.timeframe ?? ""} candle ${t.candleTime} (${t.candleState ?? ""})` : undefined}>
      {t.label} = <span className="text-foreground">{fmt(t.current)}</span>
      {t.previous !== undefined && <> (prev {fmt(t.previous)})</>}
    </span>
  );
}
