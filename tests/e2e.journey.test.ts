/**
 * M24 end-to-end journey through the real HTTP route handlers (session cookie, origin checks, validation,
 * services, engines, outbox, Telegram client against a mock Bot API). One user story, start to finish:
 *
 *   connect a bot → create an indicator-condition alert → dry-run it → create a TradingView webhook → push bars
 *   → worker cycle evaluates on candle close → Telegram message with the trigger reason → history + evidence
 *   → duplicate webhook delivery does nothing → backtest the alert → export/import → pause all / resume all.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { db, disconnectDb } from "@/lib/db";
import { randomToken } from "@/lib/crypto";
import { hashSessionToken, SESSION_COOKIE } from "@/lib/auth/session";
import { resetRateLimits } from "@/lib/rate-limit";
import { evaluateConditionAlerts } from "@/lib/engine/condition-engine";
import { sweepDueDeliveries } from "@/lib/notifications/delivery";
import { runNextBacktest } from "@/lib/services/backtests";
import { DEFAULT_TEMPLATE } from "@/lib/constants";
import * as botsRoute from "@/app/api/telegram/bots/route";
import * as alertsRoute from "@/app/api/alerts/route";
import * as alertRoute from "@/app/api/alerts/[id]/route";
import * as versionsRoute from "@/app/api/alerts/[id]/versions/route";
import * as debugRoute from "@/app/api/debug/route";
import * as webhooksRoute from "@/app/api/settings/webhooks/route";
import * as tvRoute from "@/app/api/webhooks/tradingview/[secret]/route";
import * as historyRoute from "@/app/api/history/route";
import * as evidenceRoute from "@/app/api/history/[id]/evidence/route";
import * as backtestsRoute from "@/app/api/backtests/route";
import * as backtestRoute from "@/app/api/backtests/[id]/route";
import * as exportRoute from "@/app/api/alerts/export/route";
import * as importRoute from "@/app/api/alerts/import/route";
import * as pauseAllRoute from "@/app/api/system/pause-all/route";
import * as resumeAllRoute from "@/app/api/system/resume-all/route";
import * as systemRoute from "@/app/api/system/route";
import { startMockTelegram, VALID_TOKEN, type MockTelegram } from "./helpers/mock-telegram";
import { makeUser } from "./helpers/fixtures";

const BASE = "http://localhost:3000";
const M5 = 300_000;
let tg: MockTelegram;
let token: string;
let userId: string;

function req(path: string, init: { method?: string; body?: unknown; raw?: string; cookie?: boolean } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", host: "localhost:3000", origin: BASE };
  if (init.cookie !== false) headers.cookie = `${SESSION_COOKIE}=${token}`;
  return new NextRequest(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = (params: Record<string, string> = {}) => ({ params: Promise.resolve(params) as any });
const json = async <T = Record<string, unknown>>(r: Response) => (await r.json()) as T;

beforeAll(async () => {
  tg = await startMockTelegram();
  process.env.TELEGRAM_API_URL = tg.url;
  resetRateLimits();
  userId = (await makeUser()).id;
  token = randomToken(32);
  await db.session.create({ data: { userId, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3_600_000) } });
});

afterAll(async () => {
  await tg.close();
  await disconnectDb();
});

describe("E2E: indicator alert from TradingView bars to Telegram, then backtest and operations", () => {
  const state: { botId?: string; alertId?: string; secret?: string; eventId?: string; backtestId?: string } = {};
  // Bars pushed for a fixed past morning; the "worker" evaluates just after the last bar closed.
  const start = Date.UTC(2026, 9, 2, 9, 0);
  // SMA(5) needs a fixed 24-bar window (4 × warm-up), so push 30 flat bars, then the breakout.
  const closes = [...Array(30).fill(100), 104];
  const LAST = closes.length - 1;
  const bars = closes.map((c, i) => ({
    symbol: "OANDA:E2EGOLD",
    interval: "5",
    time: new Date(start + i * M5).toISOString(),
    open: i ? closes[i - 1] : c,
    high: Math.max(c, i ? closes[i - 1] : c) + 0.5,
    low: Math.min(c, i ? closes[i - 1] : c) - 0.5,
    close: c,
    volume: 1000 + i,
  }));
  const evalAt = new Date(start + closes.length * M5 + 3_000);

  it("rejects requests without a session", async () => {
    expect((await alertsRoute.GET(req("/api/alerts", { cookie: false }), ctx())).status).toBe(401);
  });

  it("connects a Telegram bot (verified against the Bot API)", async () => {
    const r = await botsRoute.POST(
      req("/api/telegram/bots", { method: "POST", body: { name: "E2E bot", token: VALID_TOKEN, chatId: "-1001234567890" } }),
      ctx(),
    );
    expect(r.status).toBe(201);
    const { bot } = await json<{ bot: { id: string; status: string } }>(r);
    expect(bot.status).toBe("CONNECTED");
    state.botId = bot.id;
    expect(JSON.stringify(bot)).not.toContain(VALID_TOKEN); // token never returned
  });

  it("creates an indicator-condition alert (close crosses above its 5-bar SMA) and versions it", async () => {
    const r = await alertsRoute.POST(
      req("/api/alerts", {
        method: "POST",
        body: {
          name: "E2E breakout",
          symbol: "E2EGOLD",
          dataProvider: "webhook",
          kind: "CONDITIONS",
          timeframe: "5m",
          evaluationMode: "CANDLE_CLOSE",
          conditionTree: {
            id: "root",
            type: "group",
            op: "AND",
            children: [
              {
                id: "x",
                type: "compare",
                left: { kind: "price", field: "close" },
                op: "crosses_above",
                right: { kind: "indicator", indicator: "sma", params: { period: 5 } },
              },
            ],
          },
          telegramBotId: state.botId,
          messageTemplate: `${DEFAULT_TEMPLATE}\nWhy: {{trigger_reason}}\nValues: {{indicator_values}}`,
          parseMode: "PLAIN",
          triggerMode: "REARM",
          cooldownSeconds: 0,
          expiryType: "NEVER",
          status: "ACTIVE",
        },
      }),
      ctx(),
    );
    expect(r.status).toBe(201);
    const { alert } = await json<{ alert: { id: string; kind: string; configVersion: number } }>(r);
    expect(alert).toMatchObject({ kind: "CONDITIONS", configVersion: 1 });
    state.alertId = alert.id;
    const v = await json<{ versions: unknown[] }>(await versionsRoute.GET(req(`/api/alerts/${alert.id}/versions`), ctx({ id: alert.id })));
    expect(v.versions).toHaveLength(1);
  });

  it("creates a TradingView webhook and pushes bars (exchange prefix stripped)", async () => {
    const w = await json<{ webhook: { secret: string } }>(
      await webhooksRoute.POST(req("/api/settings/webhooks", { method: "POST", body: { name: "TV", kind: "TRADINGVIEW" } }), ctx()),
    );
    state.secret = w.webhook.secret;
    const tv = new NextRequest(`${BASE}/api/webhooks/tradingview/${state.secret}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify(bars),
    });
    const r = await tvRoute.POST(tv, { params: Promise.resolve({ secret: state.secret! }) });
    expect(r.status).toBe(202);
    expect(await json(r)).toMatchObject({ bars: closes.length, duplicates: 0 });
  });

  it("dry-runs the alert in the debugger: it would trigger, and nothing is written", async () => {
    const before = await db.alert.findUniqueOrThrow({ where: { id: state.alertId } });
    const r = await json<{ decision: { trigger: boolean }; evaluation: { result: boolean } }>(
      await debugRoute.POST(req("/api/debug", { method: "POST", body: { alertId: state.alertId, asOf: evalAt.toISOString() } }), ctx()),
    );
    expect(r.evaluation.result).toBe(true);
    expect(r.decision.trigger).toBe(true);
    expect((await db.alert.findUniqueOrThrow({ where: { id: state.alertId } })).version).toBe(before.version);
  });

  it("the worker cycle triggers on the closed candle and Telegram receives the explained message", async () => {
    // Start the cursor just before the breakout bar so the catch-up window covers it.
    await db.alert.update({ where: { id: state.alertId }, data: { lastEvaluatedCandle: new Date(start + (LAST - 1) * M5) } });
    const r = await evaluateConditionAlerts(evalAt);
    expect(r.triggered.map((t) => t.alertId)).toEqual([state.alertId]);
    await sweepDueDeliveries(50);
    const msg = tg.sent.find((m) => m.text.includes("E2EGOLD"));
    expect(msg).toBeTruthy();
    expect(msg!.text).toContain("Why: All required conditions satisfied.");
    expect(msg!.text).toMatch(/Values: .*SMA\(5\)/);

    // Running the same cycle again (restart / second worker) does nothing.
    await db.alert.update({ where: { id: state.alertId }, data: { lastEvaluatedCandle: new Date(start + (LAST - 1) * M5) } });
    expect((await evaluateConditionAlerts(evalAt)).triggered).toHaveLength(0);
  });

  it("history shows the trigger, delivered, with evidence explaining why", async () => {
    const h = await json<{ items: { id: string; alertId: string; delivery: { status: string }; evidence: { timeframe: string } }[] }>(
      await historyRoute.GET(req("/api/history"), ctx()),
    );
    const item = h.items.find((i) => i.alertId === state.alertId)!;
    expect(item.delivery.status).toBe("SENT");
    expect(item.evidence.timeframe).toBe("5m");
    state.eventId = item.id;
    const e = await json<{
      evidence: { candleOpenTime: string; candleState: string; providerMeta: Record<string, { source: string }>; alertVersion: number };
    }>(await evidenceRoute.GET(req(`/api/history/${item.id}/evidence`), ctx({ id: item.id })));
    expect(Date.parse(e.evidence.candleOpenTime)).toBe(start + LAST * M5);
    expect(e.evidence.candleState).toBe("CLOSED");
    expect(e.evidence.providerMeta["5m"].source).toBe("pushed");
    expect(e.evidence.alertVersion).toBe(1);
  });

  it("re-sent TradingView bars are ignored", async () => {
    const tv = new NextRequest(`${BASE}/api/webhooks/tradingview/${state.secret}`, { method: "POST", body: JSON.stringify(bars) });
    const r = await json(await tvRoute.POST(tv, { params: Promise.resolve({ secret: state.secret! }) }));
    expect(r).toMatchObject({ bars: 0, duplicates: closes.length });
  });

  it("backtests the same alert over the pushed bars and finds the same trigger", async () => {
    const r = await backtestsRoute.POST(
      req("/api/backtests", {
        method: "POST",
        body: {
          alertId: state.alertId,
          from: new Date(start).toISOString(),
          to: new Date(start + closes.length * M5).toISOString(),
          horizons: [1],
        },
      }),
      ctx(),
    );
    expect(r.status).toBe(201);
    state.backtestId = (await json<{ backtest: { id: string } }>(r)).backtest.id;
    while (await runNextBacktest());
    const b = await json<{ backtest: { status: string; triggers: { candleOpenTime: string }[]; dataset: { sha256: string } } }>(
      await backtestRoute.GET(req(`/api/backtests/${state.backtestId}`), ctx({ id: state.backtestId! })),
    );
    expect(b.backtest.status).toBe("COMPLETED");
    expect(b.backtest.triggers.map((t) => Date.parse(t.candleOpenTime))).toEqual([start + LAST * M5]);
    expect(b.backtest.dataset.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("exports and re-imports the alert (paused, bot matched by name)", async () => {
    const file = await (await exportRoute.GET(req(`/api/alerts/export?ids=${state.alertId}`), ctx())).json();
    expect(JSON.stringify(file)).not.toContain(state.botId!);
    const r = await importRoute.POST(req("/api/alerts/import", { method: "POST", body: file }), ctx());
    expect(await json(r)).toMatchObject({ imported: 1 });
    const copies = await db.alert.findMany({ where: { userId, name: "E2E breakout" }, orderBy: { createdAt: "asc" } });
    expect(copies).toHaveLength(2);
    expect(copies[1]).toMatchObject({ status: "PAUSED", telegramBotId: state.botId, kind: "CONDITIONS" });
  });

  it("pause all / resume all through the System API, audited", async () => {
    expect(await json(await pauseAllRoute.POST(req("/api/system/pause-all", { method: "POST" }), ctx()))).toMatchObject({ paused: 1 });
    expect((await db.alert.findUniqueOrThrow({ where: { id: state.alertId } })).status).toBe("PAUSED");
    expect(await json(await resumeAllRoute.POST(req("/api/system/resume-all", { method: "POST" }), ctx()))).toMatchObject({ resumed: 1 });
    const sys = await json<{ audit: { action: string }[]; alerts: { live: number } }>(await systemRoute.GET(req("/api/system"), ctx()));
    expect(sys.alerts.live).toBe(1);
    expect(sys.audit.map((a) => a.action)).toEqual(expect.arrayContaining(["alerts.pause_all", "alerts.resume_all", "alerts.import"]));
  });

  it("deleting the alert keeps its history", async () => {
    expect((await alertRoute.DELETE(req(`/api/alerts/${state.alertId}`, { method: "DELETE" }), ctx({ id: state.alertId! }))).status).toBe(
      200,
    );
    expect(await db.alertEvent.count({ where: { id: state.eventId } })).toBe(1);
    expect(await db.triggerEvidence.count({ where: { alertEventId: state.eventId } })).toBe(1);
  });
});
