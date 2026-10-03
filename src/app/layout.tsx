import type { Metadata, Viewport } from "next";
import { Schibsted_Grotesk } from "next/font/google";
import Script from "next/script";
import { Toaster } from "sonner";
import "./globals.css";

const font = Schibsted_Grotesk({ subsets: ["latin"], variable: "--font-schibsted", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Levels — Telegram price alerts", template: "%s · Levels" },
  description: "Create price alerts and deliver them to your Telegram chats.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f6f8" },
    { media: "(prefers-color-scheme: dark)", color: "#121826" },
  ],
};

// Applies the saved theme before first paint (no flash). Static string, no user data.
const themeScript = `(function(){try{var t=localStorage.getItem('theme');var d=t==='dark'||((!t||t==='system')&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d)}catch(e){}})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={font.variable} suppressHydrationWarning>
      <head>
        <Script id="theme" strategy="beforeInteractive">
          {themeScript}
        </Script>
      </head>
      <body className="min-h-dvh font-sans">
        {children}
        <Toaster position="bottom-right" richColors closeButton toastOptions={{ className: "font-sans" }} />
      </body>
    </html>
  );
}
