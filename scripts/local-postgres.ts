/**
 * Zero-install local PostgreSQL for development: downloads nothing at runtime — uses the real PostgreSQL
 * binaries shipped in the `embedded-postgres` npm package.
 *
 *   npm run db:local     → postgresql://postgres:postgres@127.0.0.1:5433/telegram_alerts (data in ./.pgdata)
 *
 * For production use a managed PostgreSQL (Neon, Supabase, RDS) or docker-compose.
 */
import fs from "node:fs";
import EmbeddedPostgres from "embedded-postgres";

const port = Number(process.env.LOCAL_PG_PORT ?? 5433);
const databaseDir = process.env.LOCAL_PG_DIR ?? "./.pgdata";
const firstRun = !fs.existsSync(databaseDir);

const pg = new EmbeddedPostgres({
  databaseDir,
  port,
  user: "postgres",
  password: "postgres",
  persistent: true,
  // Messages contain emoji: the cluster must be UTF-8 (Windows initdb defaults to WIN1252).
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  onLog: () => undefined,
});

if (firstRun) await pg.initialise();
await pg.start();
if (firstRun) await pg.createDatabase("telegram_alerts");
console.log(`[local-postgres] PostgreSQL running: postgresql://postgres:postgres@127.0.0.1:${port}/telegram_alerts`);

async function shutdown() {
  await pg.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
