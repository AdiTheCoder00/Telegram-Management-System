import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic route guard: redirects visitors without a session cookie to /login.
 * The session itself is validated against the database in the app layout and in every API route.
 *
 * Local mode (AUTH_MODE=local, loopback-bound server, localhost Host — see src/lib/auth/local-mode.ts):
 * no sign-in, so /login and /register lead straight to the dashboard.
 */
const PROTECTED = ["/dashboard", "/alerts", "/bots", "/history", "/settings"];
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

function localAccess(req: NextRequest) {
  return process.env.AUTH_MODE === "local" && process.env.LEVELS_LOOPBACK_ONLY === "1" && LOOPBACK_HOST.test(req.headers.get("host") ?? "");
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (localAccess(req)) {
    if (pathname === "/login" || pathname === "/register") return NextResponse.redirect(new URL("/dashboard", req.url));
    return NextResponse.next();
  }
  const hasSession = req.cookies.has("tam_session");
  if (!hasSession && PROTECTED.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    const url = new URL("/login", req.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
