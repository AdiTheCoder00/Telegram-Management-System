import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATE } from "@/lib/constants";
import { escapeMarkdownV2, validateMessage } from "@/lib/telegram/format";
import { buildVars, renderTemplate, SAMPLE_VARS, testHeader, unknownVariables, validateTemplate } from "@/lib/telegram/template";

describe("template rendering", () => {
  it("renders the default template", () => {
    const out = renderTemplate(DEFAULT_TEMPLATE, SAMPLE_VARS, "PLAIN");
    expect(out).toContain("Symbol: XAUUSD");
    expect(out).toContain("Current Price: 3901.25");
    expect(out).toContain("Alert: Gold Breakout Alert");
    expect(out).not.toContain("{{");
  });

  it("escapes variable values for HTML so data cannot inject markup", () => {
    const out = renderTemplate("<b>{{alert_name}}</b>", { alert_name: "<script>x</script> & co" }, "HTML");
    expect(out).toBe("<b>&lt;script&gt;x&lt;/script&gt; &amp; co</b>");
    expect(validateMessage(out, "HTML")).toEqual([]);
  });

  it("escapes MarkdownV2 reserved characters in values", () => {
    expect(escapeMarkdownV2("3901.25 (+0.03%)")).toBe("3901\\.25 \\(\\+0\\.03%\\)");
    const out = renderTemplate("*Price:* {{current_price}}", { current_price: "3901.25" }, "MARKDOWN_V2");
    expect(validateMessage(out, "MARKDOWN_V2")).toEqual([]);
  });

  it("flags unknown variables", () => {
    expect(unknownVariables("Hi {{symbol}} {{foo}}")).toEqual(["foo"]);
    expect(validateTemplate("{{bar}}", "PLAIN", SAMPLE_VARS)[0].message).toMatch(/Unknown variable/);
  });

  it("builds variables with timezone-aware time and distance", () => {
    const v = buildVars({
      alertId: "a1",
      alertName: "Gold",
      symbol: "XAUUSD",
      conditionType: "PRICE_ABOVE",
      targetPrice: 3900,
      currentPrice: 3901.25,
      at: new Date("2026-10-03T14:35:21Z"),
      timezone: "UTC",
    });
    expect(v.time).toBe("14:35:21");
    expect(v.date).toBe("2026-10-03");
    expect(v.percentage_distance).toBe("+0.03%");
    expect(v.condition).toBe("Price Above");
  });

  it("marks test messages clearly in every parse mode", () => {
    for (const mode of ["PLAIN", "MARKDOWN", "MARKDOWN_V2", "HTML"] as const) {
      const header = testHeader(mode);
      expect(header).toContain("TEST ALERT");
      expect(validateMessage(header + "ok", mode)).toEqual([]);
    }
  });
});

describe("message validation", () => {
  it("rejects unsupported / unbalanced HTML", () => {
    expect(validateMessage("<div>x</div>", "HTML").length).toBeGreaterThan(0);
    expect(validateMessage("<b>x", "HTML").length).toBeGreaterThan(0);
    expect(validateMessage("<b>x</i>", "HTML").length).toBeGreaterThan(0);
    expect(validateMessage('<a href="https://x.com">x</a> <i>y</i>', "HTML")).toEqual([]);
  });

  it("rejects unescaped MarkdownV2 characters", () => {
    expect(validateMessage("Price is 3900.5!", "MARKDOWN_V2").length).toBeGreaterThan(0);
    expect(validateMessage("Price is 3900\\.5\\!", "MARKDOWN_V2")).toEqual([]);
  });

  it("rejects unbalanced legacy Markdown and over-long messages", () => {
    expect(validateMessage("*bold", "MARKDOWN").length).toBeGreaterThan(0);
    expect(validateMessage("x".repeat(5000), "PLAIN").length).toBeGreaterThan(0);
  });
});
