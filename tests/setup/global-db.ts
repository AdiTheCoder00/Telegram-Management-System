/**
 * Starts a throwaway real PostgreSQL (embedded-postgres) for the test run and applies all migrations.
 * Set TEST_DATABASE_URL to run against an existing database instead (it must be empty / disposable).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pgPkg from "pg";
import EmbeddedPostgres from "embedded-postgres";

let pg: EmbeddedPostgres | undefined;
let dir: string | undefined;

async function migrate(url: string) {
  const client = new pgPkg.Client({ connectionString: url });
  await client.connect();
  const migrations = path.resolve(import.meta.dirname, "../../prisma/migrations");
  for (const m of fs
    .readdirSync(migrations)
    .filter((d) => fs.statSync(path.join(migrations, d)).isDirectory())
    .sort()) {
    await client.query(fs.readFileSync(path.join(migrations, m, "migration.sql"), "utf8"));
  }
  await client.end();
}

export async function setup({ provide }: { provide: (key: string, value: unknown) => void }) {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tam-test-pg-"));
    const port = 55000 + Math.floor(Math.random() * 5000);
    pg = new EmbeddedPostgres({
      databaseDir: dir,
      port,
      user: "postgres",
      password: "postgres",
      persistent: false,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
      // Deliberately non-UTC server time zone: timestamp handling must not depend on it (regression guard).
      postgresFlags: ["-c", "timezone=Asia/Kolkata"],
      onLog: () => undefined,
    });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("test");
    url = `postgresql://postgres:postgres@127.0.0.1:${port}/test`;
  }
  await migrate(url);
  provide("databaseUrl", url);
}

export async function teardown() {
  await pg?.stop();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}
