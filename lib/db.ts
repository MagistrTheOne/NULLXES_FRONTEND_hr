import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "@/db/schema";

type Sql = NeonQueryFunction<false, false>;

let sqlClient: Sql | undefined;
let dbClient: NeonHttpDatabase<typeof schema> | undefined;

function connect() {
  if (sqlClient && dbClient) {
    return;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }
  sqlClient = neon(databaseUrl);
  dbClient = drizzle(sqlClient, { schema });
}

function getSql(): Sql {
  connect();
  return sqlClient!;
}

/**
 * Lazy Neon SQL — avoids throwing during `next build` when `DATABASE_URL` is absent
 * (e.g. Vercel preview without DB env). Throws on first query at runtime if unset.
 */
export const sql = new Proxy(function noop() {} as unknown as Sql, {
  apply(_target, _thisArg, argList) {
    const fn = getSql();
    return (fn as (strings: TemplateStringsArray, ...params: unknown[]) => unknown)(
      ...(argList as [TemplateStringsArray, ...unknown[]])
    );
  },
  get(_target, prop, receiver) {
    return Reflect.get(getSql(), prop, receiver);
  },
}) as Sql;

/** Lazy Drizzle instance — same lazy connection as {@link sql}. */
export const db = new Proxy({} as NeonHttpDatabase<typeof schema>, {
  get(_target, prop, receiver) {
    connect();
    return Reflect.get(dbClient!, prop, receiver);
  },
});
