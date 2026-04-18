import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export const DEMO_COOKIE_NAME = "jobaidemo_demo";

function getDemoSecret(): string {
  const s = process.env.DEMO_SESSION_SECRET?.trim() || process.env.BETTER_AUTH_SECRET?.trim();
  if (!s) {
    throw new Error("Set DEMO_SESSION_SECRET or BETTER_AUTH_SECRET for demo sessions");
  }
  return s;
}

const DEMO_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function createDemoToken(): string {
  const payload = Buffer.from(
    JSON.stringify({ v: 1 as const, exp: Date.now() + DEMO_TTL_MS }),
    "utf8",
  ).toString("base64url");
  const sig = createHmac("sha256", getDemoSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyDemoToken(token: string): boolean {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) {
    return false;
  }
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let expected: string;
  try {
    expected = createHmac("sha256", getDemoSecret()).update(payload).digest("base64url");
  } catch {
    return false;
  }
  try {
    const a = Buffer.from(sig, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length) {
      return false;
    }
    if (!timingSafeEqual(a, b)) {
      return false;
    }
  } catch {
    return false;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    if (typeof data.exp !== "number" || Date.now() > data.exp) {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

export async function isDemoSession(): Promise<boolean> {
  const store = await cookies();
  const raw = store.get(DEMO_COOKIE_NAME)?.value;
  if (!raw) {
    return false;
  }
  return verifyDemoToken(raw);
}
