"use client";

import { useMemo, useState } from "react";
import { Braces, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { INDICATORS, getIndicator } from "@/lib/indicators/registry";
import { COMPARATORS, COMPARATOR_LABELS, conditionSchema, validateTree, type ConditionNode, type Operand } from "@/lib/conditions/types";
import { CANDLE_PATTERNS, PATTERN_LABELS } from "@/lib/market/patterns";
import { BUILTIN_SESSIONS } from "@/lib/market/sessions";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/timeframes";
import { cn } from "@/lib/utils";

/**
 * Progressive condition builder. The common case — a flat list of rules joined by AND / OR — is edited with
 * dropdowns; anything deeper (nested groups, NOT) is edited as JSON. Both produce the same ConditionNode tree,
 * validated by the same schema the server uses.
 */

type Leaf = Exclude<ConditionNode, { type: "group" } | { type: "not" }>;
type Flat = { op: "AND" | "OR"; rows: Leaf[] };

const SAME_TF = "__base";
const SESSION_LABELS: Record<(typeof BUILTIN_SESSIONS)[number], string> = { ASIA: "Asia (Tokyo)", LONDON: "London", NEW_YORK: "New York" };

let seq = 0;
const newId = () => `c${Date.now().toString(36)}${(seq++).toString(36)}`;

export function defaultTree(): ConditionNode {
  return {
    id: "root",
    type: "group",
    op: "AND",
    children: [
      {
        id: newId(),
        type: "compare",
        left: { kind: "indicator", indicator: "rsi", params: { period: 14 } },
        op: ">",
        right: { kind: "value", value: 60 },
      },
    ],
  };
}

function toFlat(tree: ConditionNode | null): Flat | null {
  if (!tree) return { op: "AND", rows: [] };
  if (tree.type === "group") {
    if (tree.children.every((c) => c.type !== "group" && c.type !== "not")) return { op: tree.op, rows: tree.children as Leaf[] };
    return null;
  }
  if (tree.type === "not") return null;
  return { op: "AND", rows: [tree] };
}

function fromFlat(f: Flat): ConditionNode | null {
  if (!f.rows.length) return null;
  return { id: "root", type: "group", op: f.op, children: f.rows };
}

/** Plain-language one-liner for the review section. */
export function describeTree(tree: ConditionNode | null, base: string): string {
  if (!tree) return "No conditions yet";
  const op = (o: Operand) => {
    if (o.kind === "value") return String(o.value);
    const tf = o.timeframe && o.timeframe !== base ? ` [${o.timeframe}]` : "";
    if (o.kind === "price") return `${o.field ?? "close"}${tf}`;
    const def = getIndicator(o.indicator);
    const params = def ? def.params.map((p) => o.params?.[p.key] ?? p.default).join(",") : "";
    const out = o.output && def && o.output !== def.defaultOutput ? `.${o.output}` : "";
    return `${def?.label ?? o.indicator}${params ? `(${params})` : ""}${out}${tf}`;
  };
  const walk = (n: ConditionNode): string => {
    switch (n.type) {
      case "group":
        return n.children.length === 1 ? walk(n.children[0]) : n.children.map(walk).join(` ${n.op} `);
      case "not":
        return `NOT (${walk(n.child)})`;
      case "compare":
        return `${op(n.left)} ${COMPARATOR_LABELS[n.op]} ${op(n.right)}`;
      case "pattern":
        return `${PATTERN_LABELS[n.pattern]}${n.timeframe && n.timeframe !== base ? ` [${n.timeframe}]` : ""}`;
      case "session":
        return `in ${typeof n.session === "string" ? SESSION_LABELS[n.session] : n.session.name} session`;
    }
  };
  return walk(tree);
}

export function ConditionBuilder({
  value,
  onChange,
  baseTimeframe,
  error,
}: {
  value: ConditionNode | null;
  onChange: (tree: ConditionNode | null) => void;
  baseTimeframe: Timeframe;
  error?: string;
}) {
  const flat = useMemo(() => toFlat(value), [value]);
  const [json, setJson] = useState<string | null>(flat ? null : JSON.stringify(value, null, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);

  const problems = useMemo(() => (value ? validateTree(value) : []), [value]);

  if (json !== null) {
    return (
      <div className="space-y-2">
        <Textarea
          rows={14}
          spellCheck={false}
          className="font-mono text-[12px]"
          value={json}
          aria-label="Condition tree (JSON)"
          onChange={(e) => {
            setJson(e.target.value);
            try {
              const r = conditionSchema.safeParse(JSON.parse(e.target.value));
              if (!r.success) throw new Error(r.error.issues[0]?.message ?? "Invalid condition tree");
              setJsonError(null);
              onChange(r.data);
            } catch (err) {
              setJsonError((err as Error).message);
            }
          }}
        />
        {(jsonError || problems[0] || error) && <p className="text-xs text-destructive">{jsonError ?? problems[0] ?? error}</p>}
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!!jsonError || !toFlat(value)}
            onClick={() => setJson(null)}
            title={toFlat(value) ? undefined : "Nested groups can only be edited as JSON"}
          >
            Back to the simple editor
          </Button>
        </div>
      </div>
    );
  }

  const f = flat ?? { op: "AND" as const, rows: [] };
  const update = (rows: Leaf[], op = f.op) => onChange(fromFlat({ op, rows }));
  const setRow = (i: number, row: Leaf) => update(f.rows.map((r, j) => (j === i ? row : r)));

  return (
    <div className="space-y-3">
      {f.rows.length > 1 && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Fire when</span>
          <Select value={f.op} onValueChange={(op) => update(f.rows, op as "AND" | "OR")}>
            <SelectTrigger className="h-8 w-40" aria-label="Combine rules">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="AND">all rules match</SelectItem>
              <SelectItem value="OR">any rule matches</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      <ol className="space-y-2">
        {f.rows.map((row, i) => (
          <li key={row.id} className="rounded-lg border bg-muted/20 p-3">
            <div className="flex items-start gap-2">
              <span className="mt-2 w-8 shrink-0 text-xs font-medium text-muted-foreground">{i === 0 ? "IF" : f.op}</span>
              <div className="min-w-0 flex-1">
                <RowEditor row={row} onChange={(r) => setRow(i, r)} baseTimeframe={baseTimeframe} />
              </div>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label="Remove rule"
                onClick={() => update(f.rows.filter((_, j) => j !== i))}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </li>
        ))}
      </ol>

      {problems[0] && <p className="text-xs text-destructive">{problems[0]}</p>}
      {!problems[0] && error && <p className="text-xs text-destructive">{error}</p>}
      {!f.rows.length && <p className="text-sm text-muted-foreground">Add at least one rule.</p>}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            update([
              ...f.rows,
              {
                id: newId(),
                type: "compare",
                left: { kind: "price", field: "close" },
                op: ">",
                right: { kind: "indicator", indicator: "ema", params: { period: 50 } },
              },
            ])
          }
        >
          <Plus /> Indicator / price rule
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => update([...f.rows, { id: newId(), type: "pattern", pattern: "bullish_engulfing" }])}
        >
          <Plus /> Candle pattern
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => update([...f.rows, { id: newId(), type: "session", session: "LONDON" }])}
        >
          <Plus /> Session filter
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setJson(JSON.stringify(value ?? defaultTree(), null, 2))}>
          <Braces /> Edit as JSON
        </Button>
      </div>
    </div>
  );
}

function RowEditor({ row, onChange, baseTimeframe }: { row: Leaf; onChange: (r: Leaf) => void; baseTimeframe: Timeframe }) {
  if (row.type === "pattern") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Select value={row.pattern} onValueChange={(p) => onChange({ ...row, pattern: p as (typeof CANDLE_PATTERNS)[number] })}>
          <SelectTrigger className="h-8 w-52" aria-label="Candle pattern">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CANDLE_PATTERNS.map((p) => (
              <SelectItem key={p} value={p}>
                {PATTERN_LABELS[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground">on</span>
        <TimeframeSelect value={row.timeframe} base={baseTimeframe} onChange={(tf) => onChange({ ...row, timeframe: tf })} />
      </div>
    );
  }
  if (row.type === "session") {
    const current = typeof row.session === "string" ? row.session : "LONDON";
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Bar is inside the</span>
        <Select value={current} onValueChange={(s) => onChange({ ...row, session: s as (typeof BUILTIN_SESSIONS)[number] })}>
          <SelectTrigger className="h-8 w-40" aria-label="Session">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BUILTIN_SESSIONS.map((s) => (
              <SelectItem key={s} value={s}>
                {SESSION_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground">session</span>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <OperandEditor value={row.left} onChange={(left) => onChange({ ...row, left })} base={baseTimeframe} allowValue={false} />
      <Select value={row.op} onValueChange={(op) => onChange({ ...row, op: op as (typeof COMPARATORS)[number] })}>
        <SelectTrigger className="h-8 w-44" aria-label="Comparison">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {COMPARATORS.map((c) => (
            <SelectItem key={c} value={c}>
              {COMPARATOR_LABELS[c]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <OperandEditor value={row.right} onChange={(right) => onChange({ ...row, right })} base={baseTimeframe} allowValue />
    </div>
  );
}

function TimeframeSelect({ value, base, onChange }: { value?: Timeframe; base: Timeframe; onChange: (tf: Timeframe | undefined) => void }) {
  return (
    <Select value={value ?? SAME_TF} onValueChange={(tf) => onChange(tf === SAME_TF ? undefined : (tf as Timeframe))}>
      <SelectTrigger className="h-8 w-32" aria-label="Timeframe">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={SAME_TF}>{base} (alert)</SelectItem>
        {TIMEFRAMES.filter((t) => t !== base).map((t) => (
          <SelectItem key={t} value={t}>
            {t}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function OperandEditor({
  value,
  onChange,
  base,
  allowValue,
}: {
  value: Operand;
  onChange: (o: Operand) => void;
  base: Timeframe;
  allowValue: boolean;
}) {
  const kindSelect = (
    <Select
      value={value.kind}
      onValueChange={(k) => {
        if (k === "value") onChange({ kind: "value", value: 0 });
        else if (k === "price") onChange({ kind: "price", field: "close" });
        else onChange({ kind: "indicator", indicator: "ema", params: { period: 50 } });
      }}
    >
      <SelectTrigger className="h-8 w-32" aria-label="Operand type">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="price">Price</SelectItem>
        <SelectItem value="indicator">Indicator</SelectItem>
        {allowValue && <SelectItem value="value">Number</SelectItem>}
      </SelectContent>
    </Select>
  );

  if (value.kind === "value") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {kindSelect}
        <Input
          className="h-8 w-36 tabular"
          inputMode="decimal"
          aria-label="Value"
          defaultValue={String(value.value)}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (e.target.value.trim() !== "" && Number.isFinite(n)) onChange({ kind: "value", value: n });
          }}
        />
      </div>
    );
  }

  if (value.kind === "price") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {kindSelect}
        <Select value={value.field ?? "close"} onValueChange={(f) => onChange({ ...value, field: f as "open" | "high" | "low" | "close" })}>
          <SelectTrigger className="h-8 w-28" aria-label="Price field">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["close", "open", "high", "low"] as const).map((f) => (
              <SelectItem key={f} value={f}>
                {f[0].toUpperCase() + f.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <TimeframeSelect value={value.timeframe} base={base} onChange={(timeframe) => onChange({ ...value, timeframe })} />
      </div>
    );
  }

  const def = getIndicator(value.indicator);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {kindSelect}
      <Select
        value={value.indicator}
        onValueChange={(k) => {
          const d = getIndicator(k)!;
          onChange({
            kind: "indicator",
            indicator: k,
            params: Object.fromEntries(d.params.map((p) => [p.key, p.default])),
            timeframe: value.timeframe,
          });
        }}
      >
        <SelectTrigger className="h-8 w-48" aria-label="Indicator">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {INDICATORS.map((d) => (
            <SelectItem key={d.key} value={d.key}>
              {d.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {def?.params.map((p) => (
        <label key={p.key} className="flex items-center gap-1 text-xs text-muted-foreground">
          {p.label}
          <Input
            className={cn("h-8 w-20 tabular")}
            inputMode="decimal"
            defaultValue={String(value.params?.[p.key] ?? p.default)}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (e.target.value.trim() !== "" && Number.isFinite(n)) onChange({ ...value, params: { ...value.params, [p.key]: n } });
            }}
          />
        </label>
      ))}
      {def && def.outputs.length > 1 && (
        <Select value={value.output ?? def.defaultOutput} onValueChange={(o) => onChange({ ...value, output: o })}>
          <SelectTrigger className="h-8 w-32" aria-label="Output">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {def.outputs.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <TimeframeSelect value={value.timeframe} base={base} onChange={(timeframe) => onChange({ ...value, timeframe })} />
    </div>
  );
}
