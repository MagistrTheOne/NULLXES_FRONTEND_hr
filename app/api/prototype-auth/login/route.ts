import { NextResponse } from "next/server";
import { loadPrototypeUsers } from "@/lib/prototype-auth-users";
import { sessionCookieName, signSessionPayload } from "@/lib/prototype-auth-cookie";

const SESSION_TTL_SEC = 60 * 60 * 24 * 7;

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.PROTOTYPE_SESSION_SECRET?.trim();
  if (!secret || secret.length < 16) {
    return NextResponse.json({ message: "PROTOTYPE_SESSION_SECRET is not configured" }, { status: 503 });
  }

  const users = loadPrototypeUsers();
  if (users.size === 0) {
    return NextResponse.json({ message: "PROTOTYPE_BASIC_AUTH is not configured" }, { status: 503 });
  }

  let body: { username?: string; password?: string };
  try {
    body = (await request.json()) as { username?: string; password?: string };
  } catch {
    return NextResponse.json({ message: "Invalid JSON" }, { status: 400 });
  }

  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const expected = users.get(username);
  if (!expected || expected !== password) {
    return NextResponse.json({ message: "Invalid credentials" }, { status: 401 });
  }

  const token = await signSessionPayload(
    {
      sub: username,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC
    },
    secret
  );

  const response = NextResponse.json({ status: "ok" });
  response.cookies.set(sessionCookieName(), token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SEC
  });
  return response;
}
