"use client";

import { Fragment, type ReactNode } from "react";
import type { ParseModeT } from "@/lib/constants";
import { cn } from "@/lib/utils";

/**
 * Renders a Telegram message the way the Telegram client would, for the live preview.
 * Builds React elements from a parsed token tree — never uses innerHTML, so it is XSS-safe.
 */

const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"' };
const decode = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|#\d+|#x[0-9a-f]+);/gi, (m) => {
    if (ENTITIES[m.toLowerCase()]) return ENTITIES[m.toLowerCase()];
    const code = m[2] === "x" || m[2] === "X" ? parseInt(m.slice(3, -1), 16) : parseInt(m.slice(2, -1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });

const safeHref = (h: string) => (/^(https?:\/\/|tg:\/\/)/i.test(h) ? h : undefined);

function wrap(tag: string, children: ReactNode, key: number, href?: string): ReactNode {
  switch (tag) {
    case "b":
    case "strong":
      return <strong key={key}>{children}</strong>;
    case "i":
    case "em":
      return <em key={key}>{children}</em>;
    case "u":
    case "ins":
      return <u key={key}>{children}</u>;
    case "s":
    case "strike":
    case "del":
      return <s key={key}>{children}</s>;
    case "code":
      return (
        <code key={key} className="rounded bg-black/5 px-1 font-mono text-[0.92em] text-[#c03c5c] dark:bg-white/10 dark:text-[#f28ba0]">
          {children}
        </code>
      );
    case "pre":
      return (
        <pre key={key} className="my-1 overflow-x-auto rounded-md bg-black/5 p-2 font-mono text-[0.9em] dark:bg-white/10">
          {children}
        </pre>
      );
    case "blockquote":
      return (
        <blockquote key={key} className="my-1 border-l-2 border-telegram pl-2">
          {children}
        </blockquote>
      );
    case "spoiler":
    case "tg-spoiler":
      return (
        <span key={key} className="rounded bg-foreground/15 text-transparent [text-shadow:0_0_6px_currentColor] hover:text-inherit">
          {children}
        </span>
      );
    case "a":
      return (
        <a
          key={key}
          href={href ? safeHref(href) : undefined}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="text-telegram underline-offset-2 hover:underline"
        >
          {children}
        </a>
      );
    default:
      return <Fragment key={key}>{children}</Fragment>;
  }
}

function renderHtml(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const stack: { tag: string; href?: string; children: ReactNode[] }[] = [{ tag: "root", children: out }];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) stack[stack.length - 1].children.push(decode(text.slice(last, m.index)));
    last = re.lastIndex;
    const [, closing, rawTag, attrs] = m;
    let tag = rawTag.toLowerCase();
    if (tag === "span" && /tg-spoiler/.test(attrs)) tag = "spoiler";
    if (closing) {
      const idx = stack.map((s) => s.tag).lastIndexOf(tag === "span" ? "spoiler" : tag);
      if (idx > 0) {
        while (stack.length > idx) {
          const node = stack.pop()!;
          stack[stack.length - 1].children.push(wrap(node.tag, node.children, key++, node.href));
        }
      }
    } else {
      const href = attrs.match(/href\s*=\s*"([^"]*)"/i)?.[1];
      stack.push({ tag, href, children: [] });
    }
  }
  if (last < text.length) stack[stack.length - 1].children.push(decode(text.slice(last)));
  while (stack.length > 1) {
    const node = stack.pop()!;
    stack[stack.length - 1].children.push(wrap(node.tag, node.children, key++, node.href));
  }
  return out;
}

const MD_V2: [string, string][] = [
  ["```", "pre"],
  ["`", "code"],
  ["||", "spoiler"],
  ["__", "u"],
  ["*", "b"],
  ["_", "i"],
  ["~", "s"],
];
const MD_LEGACY: [string, string][] = [
  ["```", "pre"],
  ["`", "code"],
  ["*", "b"],
  ["_", "i"],
];

function renderMarkdown(text: string, v2: boolean, keyBase = 0): ReactNode[] {
  const marks = v2 ? MD_V2 : MD_LEGACY;
  const out: ReactNode[] = [];
  let buf = "";
  let key = keyBase;
  let i = 0;
  const flush = () => {
    if (buf) out.push(buf);
    buf = "";
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === "[") {
      const m = text.slice(i).match(/^\[([^\]]+)\]\(([^)\s]+)\)/);
      if (m) {
        flush();
        out.push(wrap("a", renderMarkdown(m[1], v2, key * 100), key++, m[2]));
        i += m[0].length;
        continue;
      }
    }
    const mark = marks.find(([tok]) => text.startsWith(tok, i));
    if (mark) {
      const [tok, tag] = mark;
      let end = i + tok.length;
      // find matching closing token (not escaped)
      while (end < text.length) {
        if (text[end] === "\\") {
          end += 2;
          continue;
        }
        if (text.startsWith(tok, end)) break;
        end++;
      }
      if (end < text.length) {
        flush();
        const inner = text.slice(i + tok.length, end);
        const literal = tag === "code" || tag === "pre";
        out.push(wrap(tag, literal ? inner.replace(/^\w*\n/, "") : renderMarkdown(inner, v2, key * 100), key++));
        i = end + tok.length;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

export function renderTelegram(text: string, mode: ParseModeT): ReactNode[] {
  if (mode === "HTML") return renderHtml(text);
  if (mode === "MARKDOWN_V2") return renderMarkdown(text, true);
  if (mode === "MARKDOWN") return renderMarkdown(text, false);
  return [text];
}

/** A Telegram-style chat bubble. */
export function TelegramBubble({
  text,
  mode,
  botName,
  time,
  className,
}: {
  text: string;
  mode: ParseModeT;
  botName: string;
  time: string;
  className?: string;
}) {
  return (
    <div className={cn("overflow-hidden rounded-xl border", className)}>
      <div className="flex items-center gap-2.5 border-b bg-card px-3.5 py-2.5">
        <span className="flex size-8 items-center justify-center rounded-full bg-telegram text-xs font-semibold text-white">
          {botName.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 leading-tight">
          <div className="truncate text-sm font-medium">{botName}</div>
          <div className="text-xs text-muted-foreground">bot</div>
        </div>
      </div>
      <div className="bg-tg-chat bg-[radial-gradient(circle_at_20%_20%,rgba(255,255,255,0.35),transparent_40%)] p-3.5 dark:bg-none">
        <div className="relative max-w-[92%] rounded-2xl rounded-bl-md bg-tg-bubble px-3 pt-2 pb-5 text-[14px] leading-[1.4] text-foreground shadow-sm">
          {/* The preview contains the current time, which legitimately differs between server render and hydration. */}
          <div className="break-words whitespace-pre-wrap" suppressHydrationWarning>
            {renderTelegram(text, mode)}
          </div>
          <span className="absolute right-2.5 bottom-1 text-[11px] text-muted-foreground" suppressHydrationWarning>
            {time}
          </span>
        </div>
      </div>
    </div>
  );
}
