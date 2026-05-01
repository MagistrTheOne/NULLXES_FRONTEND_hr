import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import * as schema from "@/db/schema";
import { db } from "@/lib/db";

function socialProviders() {
  const providers: Record<string, { clientId: string; clientSecret: string }> = {};
  const ghId = process.env.GITHUB_CLIENT_ID?.trim();
  const ghSecret = process.env.GITHUB_CLIENT_SECRET?.trim();
  if (ghId && ghSecret) {
    providers.github = { clientId: ghId, clientSecret: ghSecret };
  }
  const googleId = process.env.GOOGLE_CLIENT_ID?.trim();
  const googleSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (googleId && googleSecret) {
    providers.google = { clientId: googleId, clientSecret: googleSecret };
  }
  return Object.keys(providers).length ? providers : undefined;
}

const baseURL = process.env.BETTER_AUTH_URL;

export const auth = betterAuth({
  baseURL,
  trustedOrigins: baseURL ? [baseURL] : [],
  user: {
    additionalFields: {
      role: {
        type: "string",
        required: false,
        defaultValue: "candidate",
      },
    },
  },
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  // https://www.better-auth.com/docs/authentication/email-password
  emailAndPassword: {
    enabled: true,
    sendResetPassword: async ({ user, url }) => {
      void Promise.resolve();
      void user;
      void url;
    },
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      void Promise.resolve();
      void user;
      void url;
    },
  },
  ...(socialProviders() ? { socialProviders: socialProviders()! } : {}),
  experimental: {
    joins: true,
  },
  plugins: [nextCookies()],
});
