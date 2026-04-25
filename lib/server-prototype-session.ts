import type { NextRequest } from "next/server";

import { sessionCookieName, verifySessionToken } from "@/lib/prototype-auth-cookie";
import { loadPrototypeUsers } from "@/lib/prototype-auth-users";

/** Валидная prototype-сессия (HR / внутренний доступ). */
export async function hasPrototypeHrSession(request: NextRequest): Promise<boolean> {
  const secret = process.env.PROTOTYPE_SESSION_SECRET?.trim();
  if (!secret || secret.length < 16) {
    return false;
  }
  const users = loadPrototypeUsers();
  if (users.size === 0) {
    return false;
  }
  const cookie = request.cookies.get(sessionCookieName())?.value;
  if (!cookie) {
    return false;
  }
  const session = await verifySessionToken(cookie, secret);
  return Boolean(session && users.has(session.sub));
}
