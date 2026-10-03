"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Bot, CheckCircle2, KeyRound, Loader2, MessageSquare, MoreHorizontal, Pencil, Plus, RefreshCw, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, Badge, Switch } from "@/components/ui/misc";
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RelativeTime } from "@/components/status";
import { api, ApiError, errorMessage } from "@/lib/client-api";
import { cn } from "@/lib/utils";

interface BotDTO {
  id: string;
  name: string;
  tokenHint: string;
  botUsername: string | null;
  chatId: string;
  chatTitle: string | null;
  enabled: boolean;
  status: "CONNECTED" | "DISCONNECTED" | "ERROR";
  lastError: string | null;
  lastCheckedAt: string | null;
  alertCount?: number;
}

const STATUS = {
  CONNECTED: { label: "Connected", variant: "up" as const, dot: "bg-up" },
  DISCONNECTED: { label: "Disconnected", variant: "muted" as const, dot: "bg-muted-foreground" },
  ERROR: { label: "Error", variant: "down" as const, dot: "bg-down" },
};

export function BotsManager({ bots }: { bots: BotDTO[] }) {
  const router = useRouter();
  const params = useSearchParams();
  // `/bots?add=1` (linked from the alert form) opens the add dialog straight away.
  const [editing, setEditing] = useState<BotDTO | "new" | null>(() => (params.get("add") === "1" ? "new" : null));
  const [deleting, setDeleting] = useState<BotDTO | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function verify(b: BotDTO) {
    setBusy(`${b.id}:verify`);
    try {
      const r = await api<{ bot: BotDTO }>(`/api/telegram/bots/${b.id}/verify`, { method: "POST" });
      if (r.bot.status === "CONNECTED") toast.success(`${b.name} is connected to ${r.bot.chatTitle ?? b.chatId}`);
      else toast.error(r.bot.lastError ?? "Telegram connection failed. Please check your bot token and Chat ID.");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function test(b: BotDTO) {
    setBusy(`${b.id}:test`);
    try {
      const r = await api<{ result: { status: string; error?: string } }>("/api/telegram/test", { method: "POST", body: { botId: b.id } });
      if (r.result.status === "sent") toast.success(`Test message sent to ${b.chatTitle ?? b.chatId}`);
      else toast.error(r.result.error ?? "Telegram message could not be delivered. Please check your bot token and Chat ID.");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function setEnabled(b: BotDTO, enabled: boolean) {
    setBusy(`${b.id}:enabled`);
    try {
      await api(`/api/telegram/bots/${b.id}`, { method: "PUT", body: { enabled } });
      toast.success(
        enabled ? `${b.name} enabled` : `${b.name} disabled. Its alerts still trigger and are recorded, but no messages are sent.`,
      );
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove(b: BotDTO) {
    try {
      const r = await api<{ affectedAlerts: number }>(`/api/telegram/bots/${b.id}`, { method: "DELETE" });
      toast.success(
        r.affectedAlerts
          ? `Deleted ${b.name}. ${r.affectedAlerts} alert${r.affectedAlerts === 1 ? " needs" : "s need"} a new bot.`
          : `Deleted ${b.name}`,
      );
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {bots.map((b) => {
          const s = STATUS[b.status];
          return (
            <Card key={b.id} className="flex min-w-0 flex-col">
              <div className="flex items-start gap-3 p-5">
                <span
                  className={cn(
                    "flex size-10 shrink-0 items-center justify-center rounded-full",
                    b.enabled ? "bg-telegram/12 text-telegram" : "bg-muted text-muted-foreground",
                  )}
                >
                  <Bot className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate font-semibold">{b.name}</h2>
                    {b.enabled ? (
                      <Badge variant={s.variant}>
                        <span className={cn("size-1.5 rounded-full", s.dot)} /> {s.label}
                      </Badge>
                    ) : (
                      <Badge variant="muted">
                        <span className="size-1.5 rounded-full border border-muted-foreground" /> Disabled
                      </Badge>
                    )}
                  </div>
                  <div className="truncate text-sm text-muted-foreground">
                    {b.botUsername ? `@${b.botUsername}` : "Bot not verified yet"}
                  </div>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${b.name}`}>
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setEditing(b)}>
                      <Pencil /> Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => verify(b)}>
                      <RefreshCw /> Test connection
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(b)}>
                      <Trash2 /> Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t px-5 py-4 text-sm">
                <div className="col-span-2">
                  <dt className="text-xs text-muted-foreground">Chat</dt>
                  <dd className="mt-0.5 flex items-center gap-1.5">
                    <MessageSquare className="size-3.5 text-muted-foreground" />
                    <span className="truncate">{b.chatTitle ?? "—"}</span>
                    <span className="text-muted-foreground tabular">{b.chatId}</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Token</dt>
                  <dd className="mt-0.5 flex items-center gap-1.5 tabular">
                    <KeyRound className="size-3.5 text-muted-foreground" />
                    {b.tokenHint}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Used by</dt>
                  <dd className="mt-0.5">
                    {b.alertCount ?? 0} alert{b.alertCount === 1 ? "" : "s"}
                  </dd>
                </div>
                <div className="col-span-2 text-xs text-muted-foreground">
                  Last checked <RelativeTime date={b.lastCheckedAt} fallback="never" />
                </div>
                <label className="col-span-2 flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                  <span>
                    <span className="block text-sm font-medium">Send messages</span>
                    <span className="block text-xs text-muted-foreground">
                      {b.enabled ? "Alerts using this bot notify you." : "Off: alerts still trigger and are logged, nothing is sent."}
                    </span>
                  </span>
                  <Switch
                    checked={b.enabled}
                    disabled={busy === `${b.id}:enabled`}
                    onCheckedChange={(c) => setEnabled(b, c)}
                    aria-label={`${b.enabled ? "Disable" : "Enable"} ${b.name}`}
                  />
                </label>
              </dl>
              {b.lastError && (
                <p
                  className={cn(
                    "mx-5 mb-4 rounded-md px-3 py-2 text-xs",
                    b.lastError.startsWith("Chat ID updated automatically")
                      ? "bg-muted text-muted-foreground"
                      : "bg-destructive/8 text-destructive",
                  )}
                >
                  {b.lastError}
                </p>
              )}
              <div className="mt-auto flex flex-col gap-2 border-t p-4 sm:flex-row">
                <Button variant="outline" size="sm" className="flex-1" onClick={() => verify(b)} disabled={!!busy}>
                  {busy === `${b.id}:verify` ? <Loader2 className="animate-spin" /> : <RefreshCw />} Test connection
                </Button>
                <Button
                  size="sm"
                  className="flex-1"
                  onClick={() => test(b)}
                  disabled={!!busy || !b.enabled}
                  title={b.enabled ? undefined : "Enable the bot to send messages"}
                >
                  {busy === `${b.id}:test` ? <Loader2 className="animate-spin" /> : <Send />} Test Telegram Message
                </Button>
              </div>
            </Card>
          );
        })}

        <button
          type="button"
          onClick={() => setEditing("new")}
          className="flex min-h-56 flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-6 text-center text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
        >
          <Plus className="size-6" />
          <span className="font-medium">Add a Telegram bot</span>
          <span className="max-w-60 text-xs">You&apos;ll need a bot token from @BotFather and the chat ID to post to.</span>
        </button>
      </div>

      <SetupGuide />

      <BotDialog
        key={editing === "new" ? "new" : (editing?.id ?? "closed")}
        bot={editing}
        onClose={() => {
          setEditing(null);
          if (params.get("add")) router.replace("/bots");
        }}
        onSaved={() => router.refresh()}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name}?`}
        description={
          deleting?.alertCount
            ? `${deleting.alertCount} alert${deleting.alertCount === 1 ? " uses" : "s use"} this bot. ${deleting.alertCount === 1 ? "It" : "They"} will be marked Error until you choose another bot. History is kept.`
            : "The token is removed permanently. History is kept."
        }
        confirmLabel="Delete bot"
        onConfirm={() => deleting && remove(deleting)}
      />
    </div>
  );
}

function SetupGuide() {
  return (
    <Card className="p-5">
      <h2 className="font-semibold">Connecting a bot</h2>
      <ol className="mt-3 grid gap-4 text-sm text-muted-foreground md:grid-cols-3">
        <li>
          <span className="font-medium text-foreground">1. Create the bot.</span> In Telegram, message{" "}
          <span className="font-medium text-foreground">@BotFather</span>, send /newbot and copy the token it gives you.
        </li>
        <li>
          <span className="font-medium text-foreground">2. Add it to your chat.</span> Start a private chat with the bot, or add it to a
          group. For a channel, add it as an administrator who can post messages.
        </li>
        <li>
          <span className="font-medium text-foreground">3. Find the chat ID.</span> Send a message in the chat, then open
          <span className="break-all">https://api.telegram.org/bot&lt;token&gt;/getUpdates</span> and copy{" "}
          <code className="text-foreground">chat.id</code>. Groups and channels start with -100.
        </li>
      </ol>
    </Card>
  );
}

function BotDialog({ bot, onClose, onSaved }: { bot: BotDTO | "new" | null; onClose: () => void; onSaved: () => void }) {
  const isNew = bot === "new";
  const existing = bot && bot !== "new" ? bot : null;
  // Initial values come from props; the parent keys this component by bot so state resets per bot.
  const [name, setName] = useState(existing?.name ?? "");
  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState(existing?.chatId ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function testFirst() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api<{ result: { status: string; error?: string; chatTitle?: string; chatId?: string } }>("/api/telegram/test", {
        method: "POST",
        body: { token: token.trim(), chatId: chatId.trim() },
      });
      // Telegram may report a new ID for a group that was upgraded to a supergroup — save that one.
      const migrated = r.result.chatId && r.result.chatId !== chatId.trim() ? r.result.chatId : null;
      if (migrated) setChatId(migrated);
      setTestResult(
        r.result.status === "sent"
          ? {
              ok: true,
              text: `Message delivered to ${r.result.chatTitle ?? chatId}. Check Telegram.${
                migrated ? ` This group was upgraded, so its Chat ID changed to ${migrated} — updated above.` : ""
              }`,
            }
          : { ok: false, text: r.result.error ?? "Telegram message could not be delivered." },
      );
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      setTestResult({ ok: false, text: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    try {
      const body: Record<string, string> = { name: name.trim(), chatId: chatId.trim() };
      if (token.trim()) body.token = token.trim();
      const r = isNew
        ? await api<{ bot: BotDTO }>("/api/telegram/bots", { method: "POST", body })
        : await api<{ bot: BotDTO }>(`/api/telegram/bots/${existing!.id}`, { method: "PUT", body });
      if (r.bot.status === "CONNECTED") toast.success(`${r.bot.name} saved and connected`);
      else toast.warning(`${r.bot.name} saved, but the connection check failed: ${r.bot.lastError ?? "unknown problem"}`);
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={!!bot} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isNew ? "Add a Telegram bot" : `Edit ${existing?.name}`}</DialogTitle>
          <DialogDescription>
            {isNew
              ? "The token is encrypted before it's stored and is never shown again."
              : "Leave the token empty to keep the current one."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4" noValidate>
          <div>
            <Label htmlFor="bot-name">Bot name</Label>
            <Input
              id="bot-name"
              className="mt-1.5"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Trading Alerts"
              aria-invalid={!!errors.name}
            />
            {errors.name && <p className="mt-1 text-xs text-destructive">{errors.name}</p>}
          </div>
          <div>
            <Label htmlFor="bot-token">Bot token</Label>
            <Input
              id="bot-token"
              className="mt-1.5 font-mono text-[13px]"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={isNew ? "123456:ABC-DEF…" : existing?.tokenHint}
              aria-invalid={!!errors.token}
            />
            {errors.token && <p className="mt-1 text-xs text-destructive">{errors.token}</p>}
          </div>
          <div>
            <Label htmlFor="bot-chat">Chat ID</Label>
            <Input
              id="bot-chat"
              className="mt-1.5 tabular"
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              placeholder="-1001234567890"
              aria-invalid={!!errors.chatId}
            />
            {errors.chatId ? (
              <p className="mt-1 text-xs text-destructive">{errors.chatId}</p>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">A user, group or channel ID, or @channelusername.</p>
            )}
          </div>
          {testResult && (
            <p
              className={cn(
                "flex items-start gap-2 rounded-md px-3 py-2 text-sm",
                testResult.ok ? "bg-up/10 text-up" : "bg-destructive/10 text-destructive",
              )}
              role="status"
            >
              {testResult.ok && <CheckCircle2 className="mt-0.5 size-4 shrink-0" />}
              {testResult.text}
            </p>
          )}
          <DialogFooter className="sm:justify-between">
            <Button type="button" variant="outline" onClick={testFirst} disabled={testing || !token.trim() || !chatId.trim()}>
              {testing ? <Loader2 className="animate-spin" /> : <Send />} Send test message
            </Button>
            <Button type="submit" disabled={saving || !name.trim() || !chatId.trim() || (isNew && !token.trim())}>
              {saving && <Loader2 className="animate-spin" />}
              {isNew ? "Save bot" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
