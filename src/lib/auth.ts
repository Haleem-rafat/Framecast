import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";

import { env } from "@/config/env";
import { prisma } from "@/lib/prisma";
import { MIN_PASSWORD_LENGTH } from "@/schemas/auth.schema";
import { accountService } from "@/services/account.service";

/** Reset links are relayed by hand, so a one-hour default would expire mid-relay. */
const RESET_TOKEN_TTL_SECONDS = 60 * 60 * 2;

/**
 * Addresses that skip the approvals queue.
 *
 * This used to be a hard allowlist: an address that was not on it could not
 * hold an account at all. Registration is open now and the approvals queue is
 * the gate, so the list has one job left — solving the bootstrap. Approving an
 * account requires an already-approved operator, so on a fresh database with
 * an empty queue there would be nobody who could ever approve anybody. The
 * seeded operator (and anyone in AUTH_ALLOWED_EMAILS) is therefore approved at
 * creation, and every other account waits.
 *
 * It grants *approval only*, and deliberately not the OPERATOR role that
 * deciding registrations now also requires. An env var that silently conferred
 * privilege on whoever happened to be listed in it is the same implicit grant
 * the role column exists to remove — see the UserRole comment in
 * schema.prisma. So the bootstrap on a fresh database is two steps rather than
 * one: register the address in this list, then run `pnpm promote:operator
 * <email>` at the server. Until that second step the account can use the
 * studio and cannot decide anybody else's.
 *
 * `role` is likewise absent from `additionalFields` below, and that absence is
 * load-bearing: Better Auth's adapter drops any field its schema does not
 * declare, so a sign-up body carrying `"role": "OPERATOR"` cannot reach
 * Postgres and the column's own `MEMBER` default supplies the value instead.
 * Declaring it here — even with `input: false` — would be more surface for no
 * gain, because nothing in the auth layer ever writes it.
 */
const autoApprovedEmails = new Set(
  [env.SEED_USER_EMAIL, ...(env.AUTH_ALLOWED_EMAILS?.split(",") ?? [])]
    .map((email) => email?.trim().toLowerCase())
    .filter((email): email is string => Boolean(email)),
);

export const auth = betterAuth({
  appName: "Framecast",
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,

  database: prismaAdapter(prisma, { provider: "postgresql" }),

  emailAndPassword: {
    enabled: true,
    minPasswordLength: MIN_PASSWORD_LENGTH,

    /**
     * There is no email transport in this repo, so nothing here can send a
     * link. `sendResetPassword` writes it to the activity log instead and says
     * so out loud — see AccountService.recordPasswordResetRequest and
     * PASSWORD_RESET_DELIVERY in src/config/env.ts. Better Auth refuses the
     * whole /request-password-reset endpoint unless this callback exists, so
     * omitting it would break the flow rather than degrade it.
     */
    resetPasswordTokenExpiresIn: RESET_TOKEN_TTL_SECONDS,
    sendResetPassword: async ({ user, url }) => {
      await accountService.recordPasswordResetRequest({
        userId: user.id,
        email: user.email,
        url,
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_SECONDS * 1000),
      });
    },

    /**
     * A password reset is the remedy for a session someone else is holding, so
     * completing one has to end those sessions. Without this the attacker's
     * cookie outlives the password it was obtained with.
     */
    revokeSessionsOnPasswordReset: true,
    onPasswordReset: async ({ user }) => {
      await accountService.recordPasswordResetCompleted({
        userId: user.id,
        email: user.email,
      });
    },
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

  user: {
    additionalFields: {
      /**
       * Declared so the create hook below can write it — Better Auth's adapter
       * drops any field its schema does not know about, so an undeclared
       * `approval` would silently never reach Postgres and the seeded operator
       * would lock themselves out of their own studio.
       *
       * `input: false` is the security-relevant half: it makes Better Auth
       * reject a sign-up body that carries an `approval` of its own, so nobody
       * can register straight into APPROVED by adding one field to a POST.
       *
       * `returned: false` keeps it off the session user. That is deliberate:
       * the copy in the session cookie can be up to five minutes stale, and
       * the gate in src/server/session.ts reads the column directly instead.
       * Not returning it means no future caller can mistake the stale copy for
       * the authoritative one.
       */
      approval: {
        type: "string",
        required: false,
        input: false,
        returned: false,
      },
      /** Declared for the same reason, and hidden for the same reason. */
      approvedAt: {
        type: "date",
        required: false,
        input: false,
        returned: false,
      },
    },
  },

  databaseHooks: {
    user: {
      create: {
        /**
         * Runs for every creation path — email/password sign-up and Google
         * alike — which is why the bootstrap exception lives here rather than
         * in the sign-up route. Everyone else falls through untouched and
         * takes the column's `PENDING` default: the gate fails closed if this
         * hook is ever changed or skipped.
         */
        before: async (user) => {
          if (!autoApprovedEmails.has(user.email.trim().toLowerCase())) {
            return { data: user };
          }

          return {
            data: { ...user, approval: "APPROVED", approvedAt: new Date() },
          };
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
