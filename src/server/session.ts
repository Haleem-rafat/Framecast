import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { isPreviewMode } from "@/config/env";
import { auth, type Session, type SessionUser } from "@/lib/auth";
import { UnauthorizedError } from "@/lib/errors";

/**
 * TEMPORARY — design-preview only, and unreachable unless PREVIEW_MODE=true,
 * which `config/env.ts` refuses to accept in production. Delete with PREVIEW_MODE.
 */
const PREVIEW_USER: SessionUser = {
  id: "00000000-0000-4000-8000-000000000000",
  name: "Studio Operator",
  email: "preview@localhost",
  emailVerified: true,
  image: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

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
  if (isPreviewMode) {
    return PREVIEW_USER;
  }

  const session = await getSession();

  if (!session) {
    redirect("/sign-in");
  }

  return session.user;
}
