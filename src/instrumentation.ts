/**
 * Next.js startup hook: validates the environment once when the server boots (Node.js runtime only).
 * Invalid configuration aborts startup instead of failing later on the first request.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { checkEnv } = await import("@/lib/env");
  const { logger } = await import("@/lib/logger");
  const { errors, warnings } = checkEnv();
  for (const w of warnings) logger.warn(`Config: ${w}`);
  if (errors.length) {
    for (const e of errors) logger.error(`Config: ${e}`);
    throw new Error(`Invalid configuration (${errors.length} error${errors.length === 1 ? "" : "s"}); see the log above.`);
  }
}
