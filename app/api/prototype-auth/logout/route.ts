import { NextResponse } from "next/server";
import { sessionCookieName } from "@/lib/prototype-auth-cookie";

export async function POST(): Promise<Response> {
  const response = NextResponse.json({ status: "ok" });
  response.cookies.set(sessionCookieName(), "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0
  });
  return response;
}
