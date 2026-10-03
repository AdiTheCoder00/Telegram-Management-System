import { cn } from "@/lib/utils";

/** Logo: a price level line with a signal lamp sitting on it. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("size-8", className)}>
      <rect width="32" height="32" rx="9" fill="#1B2333" />
      <path
        d="M5 21 L11 15 L15 18 L21 10 L27 13"
        stroke="#5D6678"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M4 13 H28" stroke="#E8A317" strokeWidth="2" strokeDasharray="3 2.5" />
      <circle cx="21" cy="13" r="3.2" fill="#E8A317" />
    </svg>
  );
}

export function Brand({ className, inverted }: { className?: string; inverted?: boolean }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <BrandMark />
      <span className={cn("text-[17px] font-semibold tracking-tight", inverted ? "text-white" : "text-foreground")}>Levels</span>
    </span>
  );
}
