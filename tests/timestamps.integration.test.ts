/**
 * Regression: timestamps must be stored as absolute instants regardless of the DB server/session time zone.
 * Bug (fixed in migration 20261003120000_utc_timestamptz): Quote."updatedAt" was written with NOW() into a
 * `timestamp without time zone` column; on an Asia/Calcutta server it was stored 5h30m in the future,
 * so stale prices looked fresh. The test database runs with timezone=Asia/Kolkata to keep this covered.
 */
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { inject } from "vitest";
import { db, disconnectDb } from "@/lib/db";
import { recordQuote, latestQuote, GLOBAL_SCOPE } from "@/lib/engine/quotes";

afterAll(() => disconnectDb());

describe("timestamp integrity", () => {
  it("stores every timestamp column as timestamptz", async () => {
    const rows = await db.$queryRaw<{ table_name: string; column_name: string; data_type: string }[]>`
      SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type LIKE 'timestamp%' AND table_name <> '_prisma_migrations'`;
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.filter((r) => r.data_type !== "timestamp with time zone")).toEqual([]);
  });

  it("records quote receive time from the app clock, not the DB session zone", async () => {
    const before = Date.now();
    const sourceTime = new Date(before - 2_000);
    await recordQuote("simulated", GLOBAL_SCOPE, "TZTEST", 100, sourceTime);
    const q = await latestQuote("simulated", "TZTEST");
    expect(q).not.toBeNull();
    expect(q!.sourceTime.getTime()).toBe(sourceTime.getTime());
    // Within a few seconds of now — the bug put it 5.5 hours in the future.
    expect(Math.abs(q!.updatedAt.getTime() - before)).toBeLessThan(5_000);
  });

  it("is read back identically by a client whose session uses another time zone", async () => {
    const instant = new Date("2026-10-03T14:35:21.123Z");
    await recordQuote("simulated", GLOBAL_SCOPE, "TZTEST2", 1, instant);
    const client = new pg.Client({ connectionString: inject("databaseUrl"), options: "-c TimeZone=America/New_York" });
    await client.connect();
    const { rows } = await client.query(`SELECT "sourceTime" FROM "Quote" WHERE symbol = 'TZTEST2'`);
    await client.end();
    expect((rows[0].sourceTime as Date).toISOString()).toBe(instant.toISOString());
  });

  it("Prisma writes the exact instant even though the server time zone is not UTC", async () => {
    // Regression: the pg driver sends Dates without an offset; without the UTC session pin a worker on an
    // Asia/Calcutta server wrote heartbeats 5h30m in the past (observed during M0).
    const instant = new Date("2026-10-03T10:24:06.237Z");
    await db.workerHeartbeat.create({ data: { id: "tz-regression", startedAt: instant, lastSeenAt: instant } });
    const client = new pg.Client({ connectionString: inject("databaseUrl") }); // server default zone (Asia/Kolkata)
    await client.connect();
    const { rows } = await client.query(`SELECT "lastSeenAt" FROM "WorkerHeartbeat" WHERE id = 'tz-regression'`);
    await client.end();
    await db.workerHeartbeat.delete({ where: { id: "tz-regression" } });
    expect((rows[0].lastSeenAt as Date).toISOString()).toBe(instant.toISOString());
  });

  it("pins Prisma sessions to UTC", async () => {
    const [{ tz }] = await db.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`;
    expect(tz).toBe("UTC");
  });
});
