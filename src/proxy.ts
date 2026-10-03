import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic route guard: redirects visitors without a session cookie to /login.
 * The session itself is validated against the database in the app layout and in every API route.
 */
const PROTECTED = ["/dashboard", "/alerts", "/bots", "/history", "/settings"];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
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
