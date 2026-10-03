"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Copy, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/dialog";
import { RelativeTime } from "@/components/status";
import { SecurityCard } from "@/components/settings/security-card";
import { WebhooksCard, type WebhookRow } from "@/components/settings/webhooks-card";
import { api, ApiError, errorMessage } from "@/lib/client-api";

interface Key {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast.error("Copy failed — select the text and copy it manually.");
        }
      }}
    >
      {done ? <Check /> : <Copy />} {done ? "Copied" : label}
    </Button>
  );
}

export function SettingsView({
  user,
  localMode,
  keys,
  webhooks,
  appUrl,
}: {
  user: { name: string | null; email: string; timezone: string };
  localMode: boolean;
  keys: Key[];
  webhooks: WebhookRow[];
  appUrl: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(user.name ?? "");
  const [email, setEmail] = useState(user.email);
  const [timezone, setTimezone] = useState(user.timezone);
  const [saving, setSaving] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Key | null>(null);
  // Browser origin on the client, APP_URL during SSR.
  const origin = useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => appUrl,
  );

  // Browsers' list omits "UTC" (and may omit legacy aliases), so always include it and the saved zone —
  // otherwise the select renders blank for those users.
  const zones = useMemo(() => {
    let list: string[] = [];
    try {
      list = (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone");
    } catch {
      /* very old browser */
    }
    return [...new Set(["UTC", user.timezone, ...list])];
  }, [user.timezone]);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api("/api/settings", { method: "PUT", body: { name, email, timezone } });
      toast.success("Settings saved");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? (Object.values(err.fieldErrors)[0] ?? err.message) : errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function createKey(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const r = await api<{ key: { key: string } }>("/api/settings/api-keys", { method: "POST", body: { name: keyName || "Webhook" } });
      setNewKey(r.key.key);
      setKeyName("");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  async function revoke(k: Key) {
    try {
      await api(`/api/settings/api-keys/${k.id}`, { method: "DELETE" });
      toast.success(`Revoked “${k.name}”`);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const endpoint = `${origin}/api/webhooks/price`;
  const curl = `curl -X POST ${endpoint} \\
  -H "Authorization: Bearer ${newKey ?? "<your key>"}" \\
  -H "Content-Type: application/json" \\
  -d '{"symbol":"XAUUSD","price":3901.25,"timestamp":"2026-10-03T14:35:00Z"}'`;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      <Card className="min-w-0 self-start p-5">
        <h2 className="font-semibold">Profile</h2>
        <form onSubmit={saveProfile} className="mt-4 space-y-4">
          <div>
            <Label htmlFor="s-name">Name</Label>
            <Input id="s-name" className="mt-1.5" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="s-email">Email</Label>
            <Input id="s-email" type="email" className="mt-1.5" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="s-tz">Timezone</Label>
            <Select value={timezone} onValueChange={setTimezone}>
              <SelectTrigger id="s-tz" className="mt-1.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {zones.map((z) => (
                  <SelectItem key={z} value={z}>
                    {z}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Used for {"{{time}}"} and {"{{date}}"} in messages and for “Triggered today”.
            </p>
          </div>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />} Save settings
          </Button>
        </form>
      </Card>

      <Card className="min-w-0 p-5">
        <h2 className="font-semibold">Price webhook keys</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Let TradingView or your own scripts push prices to alerts that use the “Webhook / TradingView” price source. A key only affects
          your own alerts.
        </p>

        <form onSubmit={createKey} className="mt-4 flex gap-2">
          <Input
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
            placeholder="Key name, e.g. TradingView"
            maxLength={60}
            aria-label="Key name"
          />
          <Button type="submit" disabled={creating} className="shrink-0">
            {creating ? <Loader2 className="animate-spin" /> : <Plus />} Create key
          </Button>
        </form>

        {newKey && (
          <div className="mt-4 rounded-lg border border-signal/50 bg-signal-soft p-4">
            <p className="text-sm font-medium">Copy this key now — it won&apos;t be shown again.</p>
            <code className="mt-2 block rounded-md bg-card px-3 py-2 text-[13px] break-all">{newKey}</code>
            <div className="mt-3 flex gap-2">
              <CopyButton text={newKey} label="Copy key" />
              <Button variant="ghost" size="sm" onClick={() => setNewKey(null)}>
                I&apos;ve saved it
              </Button>
            </div>
          </div>
        )}

        <ul className="mt-4 divide-y rounded-lg border">
          {keys.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted-foreground">No keys yet.</li>}
          {keys.map((k) => (
            <li key={k.id} className="flex items-center gap-3 px-4 py-3">
              <KeyRound className="size-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{k.name}</div>
                <div className="text-xs text-muted-foreground">
                  <span className="tabular">{k.prefix}…</span> · last used <RelativeTime date={k.lastUsedAt} fallback="never" />
                </div>
              </div>
              <Button variant="ghost" size="icon-sm" onClick={() => setRevoking(k)} aria-label={`Revoke ${k.name}`}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>

        <div className="mt-6 space-y-3 text-sm">
          <h3 className="font-medium">Sending prices</h3>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-md bg-muted px-3 py-2 text-[13px]">POST {endpoint}</code>
            <CopyButton text={endpoint} label="Copy URL" />
          </div>
          <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 text-[12px] leading-relaxed">{curl}</pre>
          <p className="text-muted-foreground">
            TradingView can&apos;t set headers: use <code className="break-all text-foreground">{endpoint}?key=&lt;your key&gt;</code> as
            the webhook URL and{" "}
            <code className="break-all text-foreground">{`{"symbol":"{{ticker}}","price":{{close}},"timestamp":"{{timenow}}"}`}</code> as
            the message. Add an <code className="text-foreground">id</code> field to make retries idempotent.
          </p>
        </div>
      </Card>

      <WebhooksCard webhooks={webhooks} origin={origin} CopyButton={CopyButton} />

      <SecurityCard localMode={localMode} />

      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke “${revoking?.name}”?`}
        description="Anything using this key will immediately get 401 Unauthorized."
        confirmLabel="Revoke key"
        onConfirm={() => revoking && revoke(revoking)}
      />
    </div>
  );
}
