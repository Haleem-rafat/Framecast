import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";

import { env, isProduction } from "@/config/env";
import { prisma } from "@/lib/prisma";

/**
 * Who is allowed to hold an account at all. Seeded operator plus anything in
 * AUTH_ALLOWED_EMAILS. Opening this up later is a config change, not a rewrite.
 */
const allowedOperatorEmails = new Set(
  [env.SEED_USER_EMAIL, ...(env.AUTH_ALLOWED_EMAILS?.split(",") ?? [])]
    .map((email) => email?.trim().toLowerCase())
    .filter((email): email is string => Boolean(email)),
);

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

  /**
   * Login only — identity scopes, nothing more. Publishing to YouTube is a
   * separate authorization with its own scopes and its own refresh token,
   * stored on `Channel`. Keeping them apart means the sign-in consent screen
   * never asks for upload permission.
   */
  ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    ? {
        socialProviders: {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
          },
        },
      }
    : {}),

  databaseHooks: {
    user: {
      create: {
        /**
         * `disableSignUp` above governs email/password only — social sign-in
         * creates users through a different path. Without this, any Google
         * account on the internet could sign into the studio. The allowlist is
         * the single gate every creation path has to pass.
         */
        before: async (user) => {
          if (!allowedOperatorEmails.has(user.email.trim().toLowerCase())) {
            throw new Error(`${user.email} is not an authorised operator.`);
          }

          return { data: user };
        },
      },
    },
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
