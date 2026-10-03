import type { ParseModeT } from "@/lib/constants";
import { TELEGRAM_MAX_MESSAGE } from "@/lib/constants";

/**
 * Formatting helpers for Telegram's parse modes. Shared by the server (sending) and the client (preview).
 * Variable values are always escaped for the selected parse mode so data such as symbols or alert
 * names can never inject formatting or break a message.
 */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** MarkdownV2 requires escaping of: _ * [ ] ( ) ~ ` > # + - = | { } . ! and backslash. */
export function escapeMarkdownV2(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

/** Legacy Markdown only treats _ * ` [ as special. */
export function escapeMarkdown(s: string): string {
  return s.replace(/[_*`[]/g, (c) => `\\${c}`);
}

export function escapeFor(mode: ParseModeT, s: string): string {
  switch (mode) {
    case "HTML":
      return escapeHtml(s);
    case "MARKDOWN_V2":
      return escapeMarkdownV2(s);
    case "MARKDOWN":
      return escapeMarkdown(s);
    default:
      return s;
  }
}

export interface ValidationIssue {
  level: "error" | "warning";
  message: string;
}

const HTML_ALLOWED = new Set([
  "b",
  "strong",
  "i",
  "em",
  "u",
  "ins",
  "s",
  "strike",
  "del",
  "a",
  "code",
  "pre",
  "tg-spoiler",
  "span",
  "blockquote",
  "tg-emoji",
]);

function validateHtml(text: string, issues: ValidationIssue[]) {
  const stack: string[] = [];
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text))) {
    const [full, rawName, attrs] = m;
    const name = rawName.toLowerCase();
    if (!HTML_ALLOWED.has(name)) {
      issues.push({ level: "error", message: `<${name}> is not a supported Telegram HTML tag.` });
      continue;
    }
    if (name === "a" && !full.startsWith("</") && !/href\s*=\s*"(https?:\/\/|tg:\/\/)[^"]*"/i.test(attrs))
      issues.push({ level: "error", message: `<a> tags need an href="https://…" attribute.` });
    if (name === "span" && !full.startsWith("</") && !/class\s*=\s*"tg-spoiler"/.test(attrs))
      issues.push({ level: "error", message: `<span> is only allowed as <span class="tg-spoiler">.` });
    if (full.startsWith("</")) {
      if (stack.pop() !== name) {
        issues.push({ level: "error", message: `Unbalanced HTML: unexpected </${name}>.` });
        return;
      }
    } else if (!full.endsWith("/>")) stack.push(name);
  }
  if (stack.length) issues.push({ level: "error", message: `Unclosed HTML tag <${stack[stack.length - 1]}>.` });
  // Bare < or & that are not entities/tags
  const stripped = text.replace(tagRe, "");
  if (/<|>/.test(stripped)) issues.push({ level: "error", message: "Use &lt; and &gt; for literal < and > in HTML mode." });
  if (/&(?!(lt|gt|amp|quot|#\d+|#x[0-9a-f]+);)/i.test(stripped))
    issues.push({ level: "error", message: "Use &amp; for a literal & in HTML mode." });
}

function validateMarkdownV2(text: string, issues: ValidationIssue[]) {
  // Remove escaped chars and code spans, then look for unescaped reserved characters.
  const noEsc = text.replace(/\\./g, "");
  const noCode = noEsc.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  const noLinks = noCode.replace(/\[[^\]]*\]\([^)]*\)/g, "");
  const reserved = noLinks.replace(/^>/gm, "").match(/[#+\-=|{}.!()\]]/g);
  // '|' is fine when used in pairs for spoilers (||text||)
  const filtered = (reserved ?? []).filter((c) => c !== "|" || !/\|\|[\s\S]*?\|\|/.test(noLinks));
  if (filtered.length)
    issues.push({
      level: "error",
      message: `MarkdownV2 requires escaping these characters with a backslash: ${[...new Set(filtered)].join(" ")}`,
    });
  for (const [tok, name] of [
    ["*", "bold"],
    ["~", "strikethrough"],
  ] as const) {
    const count = (noCode.match(new RegExp(`\\${tok}`, "g")) ?? []).length;
    if (count % 2) issues.push({ level: "error", message: `Unclosed ${name} marker "${tok}".` });
  }
  const underscores = (noCode.replace(/__/g, "").match(/_/g) ?? []).length;
  if (underscores % 2) issues.push({ level: "error", message: `Unclosed italic marker "_".` });
}

function validateMarkdown(text: string, issues: ValidationIssue[]) {
  const noEsc = text.replace(/\\./g, "");
  const noCode = noEsc.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  for (const [tok, name] of [
    ["*", "bold"],
    ["_", "italic"],
  ] as const) {
    const count = noCode.split(tok).length - 1;
    if (count % 2) issues.push({ level: "error", message: `Unclosed ${name} marker "${tok}".` });
  }
  if ((noEsc.match(/```/g) ?? []).length % 2) issues.push({ level: "error", message: "Unclosed code block ```." });
}

/** Validates a *rendered* message for the given parse mode. */
export function validateMessage(text: string, mode: ParseModeT): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!text.trim()) issues.push({ level: "error", message: "Message is empty." });
  if (text.length > TELEGRAM_MAX_MESSAGE)
    issues.push({ level: "error", message: `Message is ${text.length} characters; Telegram allows ${TELEGRAM_MAX_MESSAGE}.` });
  if (mode === "HTML") validateHtml(text, issues);
  else if (mode === "MARKDOWN_V2") validateMarkdownV2(text, issues);
  else if (mode === "MARKDOWN") validateMarkdown(text, issues);
  return issues;
}
