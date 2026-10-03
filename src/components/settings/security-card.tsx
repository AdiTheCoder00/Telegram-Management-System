"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, LogOut, Monitor, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge, Card } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/dialog";
import { RelativeTime } from "@/components/status";
import { api, ApiError, errorMessage } from "@/lib/client-api";

interface SessionRow {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  ip: string | null;
  current: boolean;
}

/** Short, readable device label from a User-Agent string. */
function describeAgent(ua: string | null) {
  if (!ua) return { label: "Unknown device", mobile: false };
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad/.test(ua)
        ? "iOS"
        : /Mac OS X/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return { label: os ? `${browser} on ${os}` : browser, mobile: /Mobile|Android|iPhone/.test(ua) };
}

export function SecurityCard() {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [confirmOthers, setConfirmOthers] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<{ sessions: SessionRow[] }>("/api/auth/sessions");
      setSessions(r.sessions);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    api<{ sessions: SessionRow[] }>("/api/auth/sessions")
      .then((r) => alive && setSessions(r.sessions))
      .catch((err) => toast.error(errorMessage(err)));
    return () => {
      alive = false;
    };
  }, []);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    try {
      const r = await api<{ revokedSessions: number }>("/api/auth/password", {
        method: "POST",
        body: { currentPassword: current, newPassword: next },
      });
      setCurrent("");
      setNext("");
      toast.success(
        r.revokedSessions
          ? `Password changed. Signed out ${r.revokedSessions} other session${r.revokedSessions === 1 ? "" : "s"}.`
          : "Password changed.",
      );
      void load();
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function revoke(id: string) {
    try {
      await api(`/api/auth/sessions/${id}`, { method: "DELETE" });
      toast.success("Session signed out");
      void load();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function revokeOthers() {
    try {
      const r = await api<{ revoked: number }>("/api/auth/sessions/revoke-others", { method: "POST" });
      toast.success(`Signed out ${r.revoked} other session${r.revoked === 1 ? "" : "s"}`);
      void load();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const others = sessions?.filter((s) => !s.current).length ?? 0;

  return (
    <Card className="min-w-0 p-5 lg:col-span-2">
      <h2 className="font-semibold">Security</h2>
      <div className="mt-4 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <form onSubmit={changePassword} className="space-y-4" noValidate>
          <h3 className="text-sm font-medium">Change password</h3>
          <div>
            <Label htmlFor="pw-current">Current password</Label>
            <Input
              id="pw-current"
              type="password"
              autoComplete="current-password"
              className="mt-1.5"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              aria-invalid={!!errors.currentPassword}
            />
            {errors.currentPassword && <p className="mt-1 text-xs text-destructive">{errors.currentPassword}</p>}
          </div>
          <div>
            <Label htmlFor="pw-new">New password</Label>
            <Input
              id="pw-new"
              type="password"
              autoComplete="new-password"
              className="mt-1.5"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              aria-invalid={!!errors.newPassword}
            />
            {errors.newPassword ? (
              <p className="mt-1 text-xs text-destructive">{errors.newPassword}</p>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">
                At least 10 characters, with a letter and a number. Other devices are signed out.
              </p>
            )}
          </div>
          <Button type="submit" disabled={saving || !current || !next}>
            {saving && <Loader2 className="animate-spin" />} Change password
          </Button>
        </form>

        <div className="min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium">Signed-in devices</h3>
            <Button variant="outline" size="sm" disabled={!others} onClick={() => setConfirmOthers(true)}>
              <LogOut /> Sign out other devices
            </Button>
          </div>
          <ul className="mt-3 divide-y rounded-lg border">
            {sessions === null && <li className="px-4 py-6 text-center text-sm text-muted-foreground">Loading…</li>}
            {sessions?.map((s) => {
              const d = describeAgent(s.userAgent);
              const Icon = d.mobile ? Smartphone : Monitor;
              return (
                <li key={s.id} className="flex items-center gap-3 px-4 py-3">
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span className="truncate">{d.label}</span>
                      {s.current && <Badge variant="up">This device</Badge>}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {s.ip ?? "unknown IP"} · active <RelativeTime date={s.lastSeenAt} /> · signed in <RelativeTime date={s.createdAt} />
                    </div>
                  </div>
                  {!s.current && (
                    <Button variant="ghost" size="sm" onClick={() => revoke(s.id)}>
                      Sign out
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOthers}
        onOpenChange={setConfirmOthers}
        title="Sign out other devices?"
        description={`${others} other session${others === 1 ? "" : "s"} will be signed out immediately. This device stays signed in.`}
        confirmLabel="Sign out others"
        onConfirm={revokeOthers}
      />
    </Card>
  );
}
