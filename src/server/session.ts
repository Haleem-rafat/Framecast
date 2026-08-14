import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import type { AccountApproval } from "@/generated/prisma/enums";
import { auth, type Session, type SessionUser } from "@/lib/auth";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";
import { accountService } from "@/services/account.service";

/**
 * Where the approval gate lives.
 *
 * Every authenticated surface in this codebase — every server action, every
 * route handler, every dashboard page — reaches the current user through this
 * file and nowhere else (`grep -r requireSession\\|requireUser\\|getSession
 * src`). That makes it the one choke point where "this account has not been
 * approved yet" can be enforced once and be true everywhere, including for a
 * hand-crafted POST straight at a server action's endpoint that never renders
 * a page and so never sees a UI check.
 *
 * The gate sits in `getSession()` itself rather than only in the two
 * `require*` helpers, because two API routes read `getSession()` directly. A
 * gate one level up would have left those open. The rule is therefore: an
 * unapproved account looks *signed out* to every existing consumer, and the
 * only way to see it is to ask for it by name through `getAccountStatus()`
 * below, which exists solely so the waiting-for-approval screen can address
 * the person by email and offer them a sign-out button.
 */

/**
 * Ungated. Private to this module — exporting it would recreate exactly the
 * bypass the gate exists to close.
 */
const getRawSession = cache(async (): Promise<Session | null> => {
  return auth.api.getSession({ headers: await headers() });
});

/**
 * Read fresh from the database on every request, deliberately *not* from the
 * session's own user record.
 *
 * Better Auth caches the session (and the user attached to it) in a signed
 * cookie for five minutes — see `session.cookieCache` in src/lib/auth.ts. If
 * the gate read approval from there, rejecting an account would leave it
 * working for up to five more minutes, which is precisely the window an
 * operator is trying to close when they hit Reject. A rejection has to take
 * effect on the very next request.
 *
 * The cost is one indexed primary-key lookup per request, and React's `cache`
 * collapses it to one per render pass however many components ask.
 */
const getApproval = cache(
  async (userId: string): Promise<AccountApproval | null> => {
    return accountService.approvalFor(userId);
  },
);

/**
 * Reason text shown when an account exists but may not use the studio.
 * `null` — the session outlived its user row — falls in with REJECTED: there
 * is nothing useful to say and nothing that should be let through either.
 */
function refusalFor(approval: AccountApproval | null): string {
  return approval === "PENDING"
    ? "Your account is waiting for an operator to approve it."
    : "Your account was not approved for this studio.";
}

/**
 * The session as the rest of the app is allowed to see it: `null` unless the
 * account is signed in *and* approved.
 *
 * `cache` dedupes the lookup across every server component in a single render
 * pass, so a layout and its nested pages cost one query, not N.
 */
export const getSession = cache(async (): Promise<Session | null> => {
  const session = await getRawSession();

  if (!session) {
    return null;
  }

  return (await getApproval(session.user.id)) === "APPROVED" ? session : null;
});

/** For server actions and route handlers — throws, letting the error boundary map it to 401/403. */
export async function requireSession(): Promise<Session> {
  const session = await getRawSession();

  if (!session) {
    throw new UnauthorizedError();
  }

  const approval = await getApproval(session.user.id);

  // 403 rather than 401: the credentials were fine, the account is not
  // cleared. Signing in again would change nothing, and telling the caller
  // otherwise would send them round a loop.
  if (approval !== "APPROVED") {
    throw new ForbiddenError(refusalFor(approval));
  }

  return session;
}

/** For server components — redirects rather than throwing. */
export async function requireUser(): Promise<SessionUser> {
  const session = await getRawSession();

  if (!session) {
    redirect("/sign-in");
  }

  if ((await getApproval(session.user.id)) !== "APPROVED") {
    redirect("/pending");
  }

  return session.user;
}

export interface AccountStatus {
  user: SessionUser;
  /** `null` when the session's user row no longer exists. */
  approval: AccountApproval | null;
}

/**
 * The one accessor that sees past the gate, for the auth pages only: /pending
 * has to greet a signed-in-but-unapproved person, and /sign-in has to send one
 * to /pending instead of showing them the form they just filled in.
 *
 * Nothing here reads or writes studio data, so seeing an unapproved session
 * costs nothing. Callers outside src/app/(auth) should use `getSession()`.
 */
export async function getAccountStatus(): Promise<AccountStatus | null> {
  const session = await getRawSession();

  if (!session) {
    return null;
  }

  return { user: session.user, approval: await getApproval(session.user.id) };
}
