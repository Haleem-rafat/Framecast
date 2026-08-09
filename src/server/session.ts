import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { auth, type Session, type SessionUser } from "@/lib/auth";
import { UnauthorizedError } from "@/lib/errors";

/**
 * `cache` dedupes the session lookup across every server component in a single
 * render pass, so a layout and its nested pages cost one query, not N.
 */
export const getSession = cache(async (): Promise<Session | null> => {
  return auth.api.getSession({ headers: await headers() });
});

/** For server actions and route handlers — throws, letting the error boundary map it to 401. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();

  if (!session) {
    throw new UnauthorizedError();
  }

  return session;
}

/** For server components — redirects to sign-in rather than throwing. */
export async function requireUser(): Promise<SessionUser> {
  const session = await getSession();

  if (!session) {
    redirect("/sign-in");
  }

  return session.user;
}
