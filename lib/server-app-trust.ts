import type { NextRequest } from "next/server";

import { auth } from "@/lib/auth";
import { hasPrototypeHrSession } from "@/lib/server-prototype-session";

/** Prototype HR или Better Auth — доверенный вызов с того же origin (cookies). */
export async function hasTrustedAppUser(request: NextRequest): Promise<boolean> {
  if (await hasPrototypeHrSession(request)) {
    return true;
  }
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    return Boolean(session?.user);
  } catch {
    return false;
  }
}
