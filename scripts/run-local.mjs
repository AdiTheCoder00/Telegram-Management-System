/**
 * Starts Next.js bound to the loopback interface only (127.0.0.1), so no other machine can connect.
 *   npm run dev          → next dev   on 127.0.0.1
 *   npm run start:local  → next start on 127.0.0.1
 *
 * It also sets LEVELS_LOOPBACK_ONLY=1. The app only honours AUTH_MODE=local (no sign-in) when this flag is
 * present — request headers alone can't prove a request is local (Host / X-Forwarded-For are forgeable).
 * Extra arguments are passed through, e.g. `npm run dev -- -p 3001`.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const [command = "dev", ...rest] = process.argv.slice(2);
if (!["dev", "start"].includes(command)) {
  console.error(`run-local: unknown command "${command}" (expected dev or start)`);
  process.exit(1);
}
const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, command, "-H", "127.0.0.1", ...rest], {
  stdio: "inherit",
  env: { ...process.env, LEVELS_LOOPBACK_ONLY: "1" },
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
