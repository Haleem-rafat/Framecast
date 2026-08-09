import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";

import { env, isProduction } from "@/config/env";
import { prisma } from "@/lib/prisma";

/**
 * The platform is single-user today, so sign-up is closed by default and there
 * is no invite flow. Multi-user support becomes a matter of re-opening
 * `disableSignUp` and scoping queries — no schema change is required.
 */
export const auth = betterAuth({
  appName: "Framecast",
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,

  database: prismaAdapter(prisma, { provider: "postgresql" }),

  emailAndPassword: {
    enabled: true,
    // Seeded via `pnpm db:seed`; there is no public registration surface.
    disableSignUp: isProduction,
    minPasswordLength: 12,
  },

  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60,
    },
  },

  advanced: {
    database: {
      generateId: false,
    },
  },

  // Must stay last: it flushes Set-Cookie headers from server actions.
  plugins: [nextCookies()],
});

export type Auth = typeof auth;
export type Session = typeof auth.$Infer.Session;
export type SessionUser = Session["user"];
