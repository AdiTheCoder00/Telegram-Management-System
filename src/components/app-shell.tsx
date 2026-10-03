"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Bell,
  BellRing,
  Bot,
  History,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Plus,
  Search,
  Settings,
  Sun,
  X,
} from "lucide-react";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/client-api";
import { cn, formatPrice } from "@/lib/utils";
import { DeliveryBadge, RelativeTime } from "@/components/status";
import type { DeliveryStatusT } from "@/lib/constants";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/alerts", label: "Alerts", icon: ListChecks },
  { href: "/alerts/new", label: "Add Alert", icon: Plus },
  { href: "/bots", label: "Telegram Bots", icon: Bot },
  { href: "/history", label: "Alert History", icon: History },
  { href: "/settings", label: "Settings", icon: Settings },
];

function isActive(pathname: string, href: string) {
  if (href === "/alerts") return pathname === "/alerts" || /^\/alerts\/[^/]+\/edit/.test(pathname);
  return pathname === href || (href !== "/dashboard" && pathname.startsWith(href + "/"));
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex h-full flex-col gap-1 bg-sidebar px-3 py-5 text-sidebar-foreground">
      <Link href="/dashboard" onClick={onNavigate} className="mb-6 px-2">
        <Brand inverted />
      </Link>
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = isActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-sidebar-active hover:text-white",
              active && "bg-sidebar-active font-medium text-white",
            )}
          >
            {active && <span className="absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-signal" />}
            <Icon className={cn("size-[18px]", active ? "text-signal" : "text-sidebar-foreground/80")} />
            {label}
          </Link>
        );
      })}
      <div className="mt-auto rounded-lg border border-white/10 px-3 py-3 text-xs leading-relaxed">
        Alerts run on the server, so you can close this tab — notifications still go out.
      </div>
    </nav>
  );
}

type Theme = "light" | "dark" | "system";
const THEME_EVENT = "theme-change";

function readTheme(): Theme {
  try {
    return (localStorage.getItem("theme") as Theme) || "system";
  } catch {
    return "system";
  }
}

function subscribeTheme(cb: () => void) {
  window.addEventListener(THEME_EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(THEME_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

/** Theme preference lives in localStorage (an external store); "system" during SSR. */
function useTheme() {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => "system" as Theme);
  const apply = (t: Theme) => {
    try {
      localStorage.setItem("theme", t);
    } catch {}
    const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
    window.dispatchEvent(new Event(THEME_EVENT));
  };
  return { theme, apply };
}

interface Notice {
  id: string;
  alertName: string;
  symbol: string;
  triggerPrice: number;
  triggeredAt: string;
  isTest: boolean;
  delivery: { status: DeliveryStatusT } | null;
}

function Notifications() {
  const [items, setItems] = useState<Notice[] | null>(null);
  const [unseen, setUnseen] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ items: Notice[] }>("/api/history?pageSize=8")
        .then((r) => {
          if (!alive) return;
          setItems(r.items);
          let seen = 0;
          try {
            seen = Number(localStorage.getItem("notices-seen") ?? 0);
          } catch {}
          setUnseen(r.items.filter((i) => new Date(i.triggeredAt).getTime() > seen).length);
        })
        .catch(() => undefined);
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) {
          setUnseen(0);
          try {
            localStorage.setItem("notices-seen", String(Date.now()));
          } catch {}
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Notifications${unseen ? ` (${unseen} new)` : ""}`} className="relative">
          {unseen ? <BellRing /> : <Bell />}
          {unseen > 0 && (
            <span className="absolute top-1.5 right-1.5 flex size-4 items-center justify-center rounded-full bg-signal text-[10px] font-semibold text-ink">
              {unseen}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="font-semibold">Recent triggers</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {!items?.length ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">No alerts have triggered yet.</p>
        ) : (
          items.map((n) => (
            <DropdownMenuItem key={n.id} asChild>
              <Link href="/history" className="flex flex-col items-start gap-1">
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="truncate font-medium">{n.alertName}</span>
                  <DeliveryBadge status={n.delivery?.status} />
                </span>
                <span className="text-xs text-muted-foreground">
                  {n.symbol} at <span className="tabular">{formatPrice(n.triggerPrice)}</span> · <RelativeTime date={n.triggeredAt} />
                </span>
              </Link>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell({ user, children }: { user: { name: string | null; email: string }; children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { theme, apply } = useTheme();

  // Close the mobile menu after navigation (adjusted during render, not in an effect).
  const [menuPath, setMenuPath] = useState(pathname);
  if (menuPath !== pathname) {
    setMenuPath(pathname);
    setMobileOpen(false);
  }

  async function signOut() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/login");
    router.refresh();
  }

  const initials = (user.name || user.email)
    .split(/\s+/)
    .map((s) => s[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[248px_1fr]">
      <aside className="sticky top-0 hidden h-dvh lg:block">
        <Sidebar />
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
          <div className="relative h-full w-72 animate-in slide-in-from-left duration-200">
            <Sidebar onNavigate={() => setMobileOpen(false)} />
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-4 right-2 text-white hover:bg-white/10"
              onClick={() => setMobileOpen(false)}
              aria-label="Close menu"
            >
              <X />
            </Button>
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b bg-background/85 px-4 backdrop-blur sm:px-6">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu">
            <Menu />
          </Button>
          <form
            role="search"
            className="relative max-w-md flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              const q = new FormData(e.currentTarget).get("q")?.toString().trim();
              router.push(q ? `/alerts?q=${encodeURIComponent(q)}` : "/alerts");
            }}
          >
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input name="q" placeholder="Search alerts or symbols" aria-label="Search alerts" className="h-9 bg-card pl-9" />
          </form>
          <div className="ml-auto flex items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Change theme">
                  <ThemeIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => apply("light")}>
                  <Sun /> Light
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => apply("dark")}>
                  <Moon /> Dark
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => apply("system")}>
                  <Monitor /> System
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Notifications />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="ml-1 flex size-9 items-center justify-center rounded-full bg-ink text-xs font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-secondary"
                  aria-label="Account menu"
                >
                  {initials}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuLabel>
                  <div className="font-medium">{user.name ?? "Account"}</div>
                  <div className="truncate text-xs text-muted-foreground">{user.email}</div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/settings">
                    <Settings /> Settings
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={signOut}>
                  <LogOut /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1320px] flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-[26px] leading-tight font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
