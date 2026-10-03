import { NextResponse } from "next/server";
import { route } from "@/lib/api";
import { clearSessionCookie, destroySessionByToken, SESSION_COOKIE } from "@/lib/auth/session";

export const POST = route(
  async ({ req }) => {
    await destroySessionByToken(req.cookies.get(SESSION_COOKIE)?.value);
    const res = NextResponse.json({ ok: true });
    clearSessionCookie(res);
    return res;
  },
  { auth: false },
);
