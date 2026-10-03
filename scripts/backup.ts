/**
 * Database backup / restore (M23) — logical, dependency-free (no pg_dump needed; works with the embedded local
 * PostgreSQL and any managed PostgreSQL).
 *
 *   npm run db:backup                         → backups/levels-<UTC timestamp>.json.gz   (every table, incl. candles)
 *   npm run db:backup -- --no-candles         → skip the Candle table (cache/tick data, can be large; re-fetchable)
 *   npm run db:restore -- <file.json.gz>      → replaces ALL data in DATABASE_URL (asks for confirmation)
 *
 * Rows are exported with row_to_json and restored with json_populate_recordset, so every column type
 * round-trips exactly. Tables are restored in foreign-key order inside one transaction: a failed restore
 * changes nothing. The schema itself comes from migrations (`npm run db:deploy`), not from the backup.
 *
 * Bot tokens stay encrypted in the backup — keep ENCRYPTION_KEY with it, or they cannot be decrypted.
 */
import "dotenv/config";
import { createReadStream, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { createGzip, createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { db, disconnectDb } from "@/lib/db";

const FORMAT = "levels-backup";
const VERSION = 1;

/** Application tables in foreign-key dependency order (parents first). */
async function tablesInOrder(): Promise<string[]> {
  const tables = (
    await db.$queryRaw<{ name: string }[]>`
      SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'`
  ).map((t) => t.name);
  const edges = await db.$queryRaw<{ child: string; parent: string }[]>`
    SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'`;
  const strip = (s: string) => s.replace(/^"|"$/g, "");
  const deps = new Map(tables.map((t) => [t, new Set<string>()]));
  for (const e of edges) if (strip(e.child) !== strip(e.parent)) deps.get(strip(e.child))?.add(strip(e.parent));
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (t: string) => {
    if (seen.has(t)) return;
    seen.add(t);
    for (const p of deps.get(t) ?? []) visit(p);
    out.push(t);
  };
  [...tables].sort().forEach(visit);
  return out;
}

async function backup(skipCandles: boolean) {
  mkdirSync("backups", { recursive: true });
  const file = path.join("backups", `levels-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}Z.json.gz`);
  const tables = (await tablesInOrder()).filter((t) => !(skipCandles && t === "Candle"));
  const counts: Record<string, number> = {};
  async function* chunks() {
    yield `{"format":"${FORMAT}","version":${VERSION},"createdAt":"${new Date().toISOString()}","tables":{`;
    for (let i = 0; i < tables.length; i++) {
      const t = tables[i];
      const rows = await db.$queryRawUnsafe<{ j: unknown }[]>(`SELECT row_to_json(x) AS j FROM "${t}" x`);
      counts[t] = rows.length;
      yield `${i ? "," : ""}${JSON.stringify(t)}:${JSON.stringify(rows.map((r) => r.j))}`;
    }
    yield `}}`;
  }
  await pipeline(Readable.from(chunks()), createGzip(), createWriteStream(file));
  console.log(`Backup written: ${file}`);
  for (const [t, n] of Object.entries(counts)) console.log(`  ${t.padEnd(18)} ${n}`);
}

async function restore(file: string) {
  if (!existsSync(file)) throw new Error(`File not found: ${file}`);
  let text = "";
  for await (const c of createReadStream(file).pipe(createGunzip())) text += c;
  const data = JSON.parse(text) as { format: string; version: number; createdAt: string; tables: Record<string, unknown[]> };
  if (data.format !== FORMAT || data.version !== VERSION) throw new Error("Not a Levels backup file (or an unsupported version).");

  const url = process.env.DATABASE_URL ?? "";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `Restore backup from ${data.createdAt} into ${url.replace(/\/\/[^@]*@/, "//***@")}?\nALL current data will be replaced. Type "restore" to continue: `,
  );
  rl.close();
  if (answer.trim() !== "restore") return console.log("Cancelled.");

  const order = (await tablesInOrder()).filter((t) => t in data.tables);
  await db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`TRUNCATE ${(await tablesInOrder()).map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
      for (const t of order) {
        const rows = data.tables[t];
        for (let i = 0; i < rows.length; i += 2000) {
          await tx.$executeRawUnsafe(`INSERT INTO "${t}" SELECT * FROM json_populate_recordset(NULL::"${t}", $1::json)`, JSON.stringify(rows.slice(i, i + 2000)));
        }
        console.log(`  ${t.padEnd(18)} ${rows.length}`);
      }
    },
    { timeout: 10 * 60_000, maxWait: 30_000 },
  );
  console.log("Restore complete. Restart the web server and the worker.");
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "backup") await backup(rest.includes("--no-candles"));
  else if (cmd === "restore" && rest[0]) await restore(rest[0]);
  else {
    console.error("Usage: npm run db:backup [-- --no-candles]  |  npm run db:restore -- <file.json.gz>");
    process.exitCode = 1;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await disconnectDb();
}
