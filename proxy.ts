import { NextResponse, type NextRequest } from "next/server";
import { sessionCookieName, verifySessionToken } from "@/lib/prototype-auth-cookie";
import { loadPrototypeUsers } from "@/lib/prototype-auth-users";

function parseBasicCredentials(header: string | null): { user: string; password: string } | null {
  if (!header?.startsWith("Basic ")) {
    return null;
  }
  try {
    const decoded = atob(header.slice(6).trim());
    const idx = decoded.indexOf(":");
    if (idx <= 0) {
      return null;
    }
    return { user: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

function isAuthConfigured(): boolean {
  const users = loadPrototypeUsers();
  const secret = process.env.PROTOTYPE_SESSION_SECRET?.trim();
  return users.size > 0 && Boolean(secret && secret.length >= 16);
}

function isPublicPath(pathname: string): boolean {
  if (pathname === "/login") {
    return true;
  }
  if (pathname.startsWith("/api/prototype-auth/")) {
    return true;
  }
  if (pathname.startsWith("/_next") || pathname.startsWith("/favicon")) {
    return true;
  }
  return false;
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (!isAuthConfigured()) {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const users = loadPrototypeUsers();
  const secret = process.env.PROTOTYPE_SESSION_SECRET!.trim();

  const basic = parseBasicCredentials(request.headers.get("authorization"));
  if (basic) {
    const expected = users.get(basic.user);
    if (expected && expected === basic.password) {
      return NextResponse.next();
    }
  }

  const cookie = request.cookies.get(sessionCookieName())?.value;
  if (cookie) {
    const session = await verifySessionToken(cookie, secret);
    if (session && users.has(session.sub)) {
      return NextResponse.next();
    }
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.searchParams.set("from", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|.*\\.(?:ico|png|jpg|jpeg|svg|webp)$).*)"]
};
