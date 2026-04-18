"use server";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { company, companyMember } from "@/db/schema";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { headers } from "next/headers";

const ROLES = ["candidate", "employer"] as const;

export async function createEmployerCompany(companyName: string) {
  const name = companyName.trim();
  if (name.length < 1 || name.length > 256) {
    return { ok: false as const, error: "Invalid company name" };
  }

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return { ok: false as const, error: "Unauthorized" };
  }

  const role = (session.user as { role?: string }).role;
  if (!role || !ROLES.includes(role as (typeof ROLES)[number]) || role !== "employer") {
    return { ok: false as const, error: "Not an employer account" };
  }

  const userId = session.user.id;

  const existing = await db
    .select({ id: companyMember.id })
    .from(companyMember)
    .where(eq(companyMember.userId, userId))
    .limit(1);
  if (existing.length > 0) {
    return { ok: false as const, error: "Company already linked" };
  }

  const companyId = randomUUID();
  await db.insert(company).values({
    id: companyId,
    name,
  });
  await db.insert(companyMember).values({
    id: randomUUID(),
    userId,
    companyId,
    memberRole: "owner",
  });

  return { ok: true as const, companyId };
}
