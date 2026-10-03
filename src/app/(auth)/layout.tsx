import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { Brand } from "@/components/brand";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  if (await getCurrentUser()) redirect("/dashboard");
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_minmax(420px,520px)]">
      <aside className="relative hidden overflow-hidden bg-sidebar p-10 text-white lg:flex lg:flex-col">
        <Brand inverted />
        <div className="mt-auto max-w-md">
          <LevelIllustration />
          <h1 className="mt-10 text-[34px] leading-[1.12] font-semibold tracking-tight">Know the moment price reaches your level.</h1>
          <p className="mt-4 text-[15px] leading-relaxed text-sidebar-foreground">
            Set a level once. Levels watches the market around the clock and sends a message to your Telegram chat when it is reached —
            once, not every few seconds.
          </p>
        </div>
      </aside>
      <main className="flex items-center justify-center px-4 py-12 sm:px-10">
        <div className="w-full max-w-sm">
          <Brand className="mb-10 lg:hidden" />
          {children}
        </div>
      </main>
    </div>
  );
}

function LevelIllustration() {
  // A price path crossing a dashed target line; the lamp marks the trigger point.
  return (
    <svg viewBox="0 0 420 180" className="w-full" aria-hidden>
      <defs>
        <linearGradient id="fade" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#2BB8A3" stopOpacity="0.25" />
          <stop offset="1" stopColor="#2BB8A3" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path
        d="M0 150 L30 138 L55 145 L85 120 L110 128 L140 104 L165 112 L195 92 L222 99 L250 70 L272 78 L300 52 L330 60 L360 38 L390 46 L420 30 L420 180 L0 180 Z"
        fill="url(#fade)"
      />
      <path
        d="M0 150 L30 138 L55 145 L85 120 L110 128 L140 104 L165 112 L195 92 L222 99 L250 70 L272 78 L300 52 L330 60 L360 38 L390 46 L420 30"
        stroke="#2BB8A3"
        strokeWidth="2.5"
        fill="none"
        strokeLinejoin="round"
      />
      <line x1="0" x2="420" y1="80" y2="80" stroke="#F2B53A" strokeWidth="1.5" strokeDasharray="6 5" />
      <text x="4" y="72" fill="#F2B53A" fontSize="12" fontWeight="600">
        3,900.00
      </text>
      <circle cx="257" cy="80" r="7" fill="#F2B53A" />
      <circle cx="257" cy="80" r="14" fill="#F2B53A" opacity="0.25" />
    </svg>
  );
}
