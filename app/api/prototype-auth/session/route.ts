import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { sessionCookieName, verifySessionToken } from "@/lib/prototype-auth-cookie";
import { loadPrototypeUsers } from "@/lib/prototype-auth-users";

export async function GET(): Promise<Response> {
  const secret = process.env.PROTOTYPE_SESSION_SECRET?.trim();
  const users = loadPrototypeUsers();
  if (!users.size || !secret || secret.length < 16) {
    return NextResponse.json({ authenticated: false, authConfigured: false });
  }

  const token = (await cookies()).get(sessionCookieName())?.value;
  if (!token) {
    return NextResponse.json({ authenticated: false, authConfigured: true });
  }

  const session = await verifySessionToken(token, secret);
  const authenticated = Boolean(session && users.has(session.sub));
  return NextResponse.json({ authenticated, authConfigured: true });
}
