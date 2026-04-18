import { createAuthClient } from "better-auth/react";
import { inferAdditionalFields } from "better-auth/client/plugins";
import type { auth } from "@/lib/auth";

const publicUrl = process.env.NEXT_PUBLIC_BETTER_AUTH_URL?.trim();

export const authClient = createAuthClient({
  plugins: [inferAdditionalFields<typeof auth>()],
  ...(publicUrl ? { baseURL: publicUrl } : {}),
});
