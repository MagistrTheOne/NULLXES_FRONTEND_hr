import { NextResponse } from "next/server";
import { createDemoToken, DEMO_COOKIE_NAME } from "@/lib/demo-session";

export async function POST() {
  const token = createDemoToken();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(DEMO_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return res;
}
