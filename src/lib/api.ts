import { NextResponse, type NextRequest } from "next/server";
import { ZodError, type ZodType } from "zod";
import { AppError, forbidden, tooManyRequests, unauthorized } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";
import { resolveRequestUser, SESSION_COOKIE, type SessionUser } from "@/lib/auth/session";

type Params = Record<string, string>;

interface Options {
  /** Require a signed-in user (default true). */
  auth?: boolean;
  /** Rate limit per user (or IP when anonymous): [requests, windowMs]. */
  rateLimit?: [number, number];
  /** Rate-limit bucket name (defaults to the route path). */
  bucket?: string;
  /** Skip same-origin (CSRF) check — only for machine endpoints authenticated by secrets (webhooks/cron). */
  skipCsrf?: boolean;
}

interface Ctx<P extends Params> {
  req: NextRequest;
  params: P;
  user: SessionUser;
  ip: string;
}

export function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF protection for cookie-authenticated endpoints: state-changing requests must come from our own origin.
 * (Session cookies are also SameSite=Lax, and every mutating endpoint requires a JSON body / non-simple request.)
 */
export function assertSameOrigin(req: NextRequest) {
  if (!UNSAFE.has(req.method)) return;
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw forbidden("Cross-site request blocked.");
  const origin = req.headers.get("origin");
  if (origin) {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw forbidden("Cross-site request blocked.");
    }
    const allowed = new Set([host, process.env.APP_URL ? new URL(process.env.APP_URL).host : null].filter(Boolean));
    if (!allowed.has(originHost)) throw forbidden("Cross-site request blocked.");
  }
}

export function errorResponse(err: unknown, req?: NextRequest): NextResponse {
  if (err instanceof AppError) {
    const fieldErrors = (err.details as { fieldErrors?: Record<string, string> } | undefined)?.fieldErrors;
    const res = NextResponse.json(
      { error: err.message, code: err.code, ...(fieldErrors ? { fieldErrors } : {}), details: err.details },
      { status: err.status },
    );
    if (err.status === 429) {
      const retry = (err.details as { retryAfterSec?: number })?.retryAfterSec;
      if (retry) res.headers.set("Retry-After", String(retry));
    }
    return res;
  }
  if (err instanceof ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of err.issues) {
      const key = issue.path.join(".") || "_";
      fieldErrors[key] ??= issue.message;
    }
    return NextResponse.json({ error: "Please fix the highlighted fields.", code: "validation_error", fieldErrors }, { status: 400 });
  }
  if (err instanceof SyntaxError) {
    return NextResponse.json({ error: "Request body must be valid JSON.", code: "bad_json" }, { status: 400 });
  }
  logger.error("Unhandled API error", { path: req?.nextUrl.pathname, method: req?.method, err });
  return NextResponse.json({ error: "Something went wrong. Please try again.", code: "internal" }, { status: 500 });
}

/** Parses and validates the JSON body. */
export async function parseBody<T>(req: NextRequest, schema: ZodType<T>): Promise<T> {
  const text = await req.text();
  if (text.length > 100_000) throw new AppError(413, "Request body too large.", "too_large");
  return schema.parse(text ? JSON.parse(text) : {});
}

export function parseQuery<T>(req: NextRequest, schema: ZodType<T>): T {
  const obj: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((v, k) => {
    if (v !== "") obj[k] = v;
  });
  return schema.parse(obj);
}

/**
 * Wraps an authenticated route handler with: session auth, CSRF origin check, rate limiting,
 * and uniform error handling (no raw backend errors ever reach the client).
 */
export function route<P extends Params = Params>(handler: (ctx: Ctx<P>) => Promise<Response | unknown>, opts: Options = {}) {
  return async (req: NextRequest, context: { params: Promise<P> }) => {
    try {
      if (!opts.skipCsrf) assertSameOrigin(req);
      const ip = clientIp(req);
      let user: SessionUser | null = null;
      if (opts.auth !== false) {
        user = await resolveRequestUser(req.cookies.get(SESSION_COOKIE)?.value, req.headers.get("host"));
        if (!user) throw unauthorized();
      }
      const [limit, windowMs] = opts.rateLimit ?? (UNSAFE.has(req.method) ? [60, 60_000] : [300, 60_000]);
      const rl = await rateLimit(`${opts.bucket ?? req.nextUrl.pathname}:${req.method}:${user?.id ?? ip}`, limit, windowMs);
      if (!rl.ok) throw tooManyRequests(rl.retryAfterSec);

      const params = ((await context?.params) ?? {}) as P;
      const result = await handler({ req, params, user: user as SessionUser, ip });
      if (result instanceof Response) return result;
      return NextResponse.json(result ?? { ok: true });
    } catch (err) {
      return errorResponse(err, req);
    }
  };
}
