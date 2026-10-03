"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Plus, Trash2, Webhook } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, Switch } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/dialog";
import { RelativeTime } from "@/components/status";
import { api, errorMessage } from "@/lib/client-api";

export interface WebhookRow {
  id: string;
  name: string;
  kind: string;
  secretPrefix: string;
  enabled: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

const TV_BAR = `{"symbol":"{{ticker}}","interval":"{{interval}}","time":"{{time}}","open":{{open}},"high":{{high}},"low":{{low}},"close":{{close}},"volume":{{volume}}}`;
const TV_TICK = `{"symbol":"{{ticker}}","price":{{close}},"timestamp":"{{timenow}}"}`;

/** TradingView / generic inbound webhooks (M13). Secrets are shown once; only a hash is stored. */
export function WebhooksCard({
  webhooks,
  origin,
  CopyButton,
}: {
  webhooks: WebhookRow[];
  origin: string;
  CopyButton: React.ComponentType<{ text: string; label: string }>;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"TRADINGVIEW" | "GENERIC">("TRADINGVIEW");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ url: string; secret: string; kind: string; id: string } | null>(null);
  const [deleting, setDeleting] = useState<WebhookRow | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const r = await api<{ webhook: { id: string; secret: string; kind: string } }>("/api/settings/webhooks", {
        method: "POST",
        body: { name: name || (kind === "TRADINGVIEW" ? "TradingView" : "Webhook"), kind },
      });
      const w = r.webhook;
      setCreated({
        id: w.id,
        kind: w.kind,
        secret: w.secret,
        url: w.kind === "TRADINGVIEW" ? `${origin}/api/webhooks/tradingview/${w.secret}` : `${origin}/api/webhooks/${w.id}`,
      });
      setName("");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  async function toggle(w: WebhookRow, enabled: boolean) {
    try {
      await api(`/api/settings/webhooks/${w.id}`, { method: "PATCH", body: { enabled } });
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function remove(w: WebhookRow) {
    try {
      await api(`/api/settings/webhooks/${w.id}`, { method: "DELETE" });
      toast.success("Webhook deleted");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <Card className="min-w-0 p-5">
      <h2 className="font-semibold">Webhooks (TradingView)</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Push prices <em>or full OHLC bars</em> into alerts that use the “Webhook / TradingView” source. Bars become the candles your
        indicator conditions run on. TradingView needs a URL it can reach — a local-only app needs a tunnel or a deployment.
      </p>

      <form onSubmit={create} className="mt-4 flex flex-wrap gap-2">
        <Input
          className="min-w-40 flex-1"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name, e.g. Gold 5m bars"
          maxLength={60}
          aria-label="Webhook name"
        />
        <Select value={kind} onValueChange={(k) => setKind(k as typeof kind)}>
          <SelectTrigger className="w-40" aria-label="Webhook type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="TRADINGVIEW">TradingView</SelectItem>
            <SelectItem value="GENERIC">Generic (header secret)</SelectItem>
          </SelectContent>
        </Select>
        <Button type="submit" disabled={creating}>
          {creating ? <Loader2 className="animate-spin" /> : <Plus />} Create webhook
        </Button>
      </form>

      {created && (
        <div className="mt-4 space-y-2 rounded-lg border border-signal/50 bg-signal-soft p-4 text-sm">
          <p className="font-medium">Copy this now — the secret won&apos;t be shown again.</p>
          <div>
            <div className="text-xs text-muted-foreground">Webhook URL</div>
            <code className="mt-1 block rounded-md bg-card px-3 py-2 text-[12px] break-all">{created.url}</code>
          </div>
          {created.kind === "GENERIC" && (
            <div>
              <div className="text-xs text-muted-foreground">Header</div>
              <code className="mt-1 block rounded-md bg-card px-3 py-2 text-[12px] break-all">X-Webhook-Secret: {created.secret}</code>
            </div>
          )}
          <div className="flex gap-2">
            <CopyButton text={created.url} label="Copy URL" />
            {created.kind === "GENERIC" && <CopyButton text={created.secret} label="Copy secret" />}
            <Button variant="ghost" size="sm" onClick={() => setCreated(null)}>
              I&apos;ve saved it
            </Button>
          </div>
        </div>
      )}

      <ul className="mt-4 divide-y rounded-lg border">
        {webhooks.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted-foreground">No webhooks yet.</li>}
        {webhooks.map((w) => (
          <li key={w.id} className="flex items-center gap-3 px-4 py-3">
            <Webhook className="size-4 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">
                {w.name}{" "}
                <span className="text-xs font-normal text-muted-foreground">· {w.kind === "TRADINGVIEW" ? "TradingView" : "Generic"}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                <span className="tabular">{w.secretPrefix}…</span> · last used <RelativeTime date={w.lastUsedAt} fallback="never" />
              </div>
            </div>
            <Switch
              checked={w.enabled}
              onCheckedChange={(v) => toggle(w, v)}
              aria-label={`${w.enabled ? "Disable" : "Enable"} ${w.name}`}
            />
            <Button variant="ghost" size="icon-sm" onClick={() => setDeleting(w)} aria-label={`Delete ${w.name}`}>
              <Trash2 />
            </Button>
          </li>
        ))}
      </ul>

      <div className="mt-6 space-y-2 text-sm">
        <h3 className="font-medium">TradingView alert message</h3>
        <p className="text-muted-foreground">Bars (recommended — set the alert to “Once per bar close”):</p>
        <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 text-[12px]">{TV_BAR}</pre>
        <p className="text-muted-foreground">Or just prices:</p>
        <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 text-[12px]">{TV_TICK}</pre>
        <p className="text-muted-foreground">
          Re-sent bars are ignored (keyed by symbol, interval and bar time); add an <code className="text-foreground">id</code> field to
          de-duplicate ticks. Max 64 KB and 100 items per request.
        </p>
      </div>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete “${deleting?.name}”?`}
        description="TradingView alerts using this URL will get 401 Unauthorized. Candles it already pushed are kept."
        confirmLabel="Delete webhook"
        onConfirm={() => deleting && remove(deleting)}
      />
    </Card>
  );
}
