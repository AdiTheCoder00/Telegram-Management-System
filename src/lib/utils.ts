import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Formats a price with sensible precision (fx pairs get more decimals than indices). */
export function formatPrice(value: number | null | undefined, decimals?: number): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const d = decimals ?? (Math.abs(value) < 10 ? 5 : Math.abs(value) < 1000 ? 2 : 2);
  return value.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function signed(value: number, decimals = 2): string {
  const s = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${s}`;
}
