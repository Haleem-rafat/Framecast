import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ForbiddenError, UnauthorizedError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

/**
 * The approval gate, tested where it lives.
 *
 * Better Auth and Next's request context are mocked — this file is not about
 * whether cookies parse — but the approval read is left real, against the same
 * Postgres the app uses. That is the half that matters: the gate's promise is
 * that it reflects the database *now*, not what the session cookie remembers.
 */
const getSessionMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: getSessionMock } },
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

/**
 * `redirect()` normally throws a Next-internal control-flow error. Throwing a
 * plainly identifiable one instead keeps these assertions about the
 * destination the gate chose rather than about Next's internals.
 */
class TestRedirect extends Error {
  constructor(readonly destination: string) {
    super(`redirect:${destination}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (destination: string) => {
    throw new TestRedirect(destination);
  },
}));

const {
  getAccountStatus,
  getSession,
  requireOperator,
  requireOperatorSession,
  requireSession,
  requireUser,
} = await import("@/server/session");

let userId: string;

/** What Better Auth would hand back for a signed-in browser. */
function signedInAs(id: string) {
  return {
    session: { id: randomUUID(), userId: id },
    user: {
      id,
      name: "Test Operator",
      email: `test-${id}@framecast.invalid`,
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

async function setApproval(approval: "PENDING" | "APPROVED" | "REJECTED") {
  await prisma.user.update({ where: { id: userId }, data: { approval } });
}

async function setRole(role: "OPERATOR" | "MEMBER") {
  await prisma.user.update({ where: { id: userId }, data: { role } });
}

beforeEach(async () => {
  userId = await createTestUser("session");
  getSessionMock.mockReset();
  getSessionMock.mockResolvedValue(signedInAs(userId));
});

afterEach(() => deleteTestUser(userId));

describe("with no session at all", () => {
  beforeEach(() => {
    getSessionMock.mockResolvedValue(null);
  });

  it("getSession returns null", async () => {
    expect(await getSession()).toBeNull();
  });

  it("requireSession throws Unauthorized", async () => {
    await expect(requireSession()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("requireUser redirects to sign-in", async () => {
    await expect(requireUser()).rejects.toMatchObject({
      destination: "/sign-in",
    });
  });
});

describe("an approved account", () => {
  beforeEach(() => setApproval("APPROVED"));

  it("is visible through getSession", async () => {
    expect((await getSession())?.user.id).toBe(userId);
  });

  it("passes requireSession", async () => {
    expect((await requireSession()).user.id).toBe(userId);
  });

  it("passes requireUser", async () => {
    expect((await requireUser()).id).toBe(userId);
  });
});

describe.each(["PENDING", "REJECTED"] as const)("a %s account", (approval) => {
  beforeEach(() => setApproval(approval));

  it("looks signed out to getSession, so every consumer of it fails closed", async () => {
    // The two API routes that stream rendered video read getSession()
    // directly rather than going through require*(). Gating here rather than
    // only in the require* helpers is what covers them.
    expect(await getSession()).toBeNull();
  });

  it("is refused by requireSession with 403, not 401", async () => {
    // This is the path a hand-crafted POST at a server action takes: it never
    // renders a page, so no UI check is involved. 403 because the credentials
    // were fine — signing in again would change nothing.
    const error = await requireSession().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as ForbiddenError).httpStatus).toBe(403);
  });

  it("is sent to the waiting-for-approval screen by requireUser", async () => {
    await expect(requireUser()).rejects.toMatchObject({
      destination: "/pending",
    });
  });

  it("can still be identified by getAccountStatus, so /pending can greet them", async () => {
    const status = await getAccountStatus();

    expect(status?.user.id).toBe(userId);
    expect(status?.approval).toBe(approval);
  });
});

/**
 * The operator gate.
 *
 * `createTestUser` writes no `role`, so its users take the column's MEMBER
 * default — which is what all 41 approved production accounts are, and what
 * every one of these tests is about.
 */
describe("the operator gate", () => {
  describe("an approved MEMBER", () => {
    beforeEach(async () => {
      await setApproval("APPROVED");
      await setRole("MEMBER");
    });

    it("is refused by requireOperator exactly as a signed-out visitor is", async () => {
      // Not merely "refused" — refused *identically*. A distinguishable
      // refusal would confirm to any of the 41 approved accounts that /admin
      // is a real route whose only lock is a flag on their own row.
      getSessionMock.mockResolvedValue(null);
      const asStranger = await requireOperator().catch((e: unknown) => e);

      getSessionMock.mockResolvedValue(signedInAs(userId));
      const asMember = await requireOperator().catch((e: unknown) => e);

      expect((asMember as TestRedirect).destination).toBe("/sign-in");
      expect((asMember as TestRedirect).destination).toBe(
        (asStranger as TestRedirect).destination,
      );
    });

    it("is refused by requireOperatorSession with the same bare 401 a signed-out request gets", async () => {
      getSessionMock.mockResolvedValue(null);
      const asStranger = await requireOperatorSession().catch(
        (e: unknown) => e,
      );

      getSessionMock.mockResolvedValue(signedInAs(userId));
      const asMember = await requireOperatorSession().catch((e: unknown) => e);

      expect(asMember).toBeInstanceOf(UnauthorizedError);
      // 401 and not 403: a ForbiddenError saying "you are not an operator"
      // would be the oracle. Byte-for-byte the stranger's message.
      expect((asMember as UnauthorizedError).httpStatus).toBe(401);
      expect((asMember as UnauthorizedError).message).toBe(
        (asStranger as UnauthorizedError).message,
      );
    });

    it("still passes the ordinary gates, so nothing else in the studio changed", async () => {
      expect((await requireUser()).id).toBe(userId);
      expect((await requireSession()).user.id).toBe(userId);
      expect((await getSession())?.user.id).toBe(userId);
    });
  });

  describe("an approved OPERATOR", () => {
    beforeEach(async () => {
      await setApproval("APPROVED");
      await setRole("OPERATOR");
    });

    it("passes requireOperator", async () => {
      expect((await requireOperator()).id).toBe(userId);
    });

    it("passes requireOperatorSession", async () => {
      expect((await requireOperatorSession()).user.id).toBe(userId);
    });
  });

  describe("an OPERATOR whose account is not approved", () => {
    // Approval is checked before the role and reports itself normally. The
    // waiting screen is a public part of registration, so it leaks nothing —
    // and hiding it here would strand the person on a loop.
    beforeEach(async () => {
      await setApproval("PENDING");
      await setRole("OPERATOR");
    });

    it("is sent to /pending, not admitted on the strength of the role", async () => {
      await expect(requireOperator()).rejects.toMatchObject({
        destination: "/pending",
      });
      await expect(requireOperatorSession()).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });
  });

  describe("a role revoked while the operator is working", () => {
    it("bites on the very next call, not when the session cookie expires", async () => {
      await setApproval("APPROVED");
      await setRole("OPERATOR");
      expect((await requireOperatorSession()).user.id).toBe(userId);

      // Same cookie, same Better Auth response — only the column moved. A
      // gate that read the role off the five-minute cookie cache would leave
      // a demoted operator deciding registrations for five more minutes.
      await setRole("MEMBER");

      await expect(requireOperatorSession()).rejects.toBeInstanceOf(
        UnauthorizedError,
      );
    });
  });
});

describe("a session whose user row has been deleted", () => {
  beforeEach(() => {
    getSessionMock.mockResolvedValue(signedInAs(randomUUID()));
  });

  it("fails closed rather than reading 'no approval recorded' as fine", async () => {
    expect(await getSession()).toBeNull();
    await expect(requireSession()).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("a decision made while the operator is working", () => {
  it("takes effect on the very next call, not when the session cookie expires", async () => {
    await setApproval("APPROVED");
    expect((await requireSession()).user.id).toBe(userId);

    // Nothing about the session changed — same cookie, same Better Auth
    // response. Only the database row moved. Better Auth caches the session
    // (and its user record) in a signed cookie for five minutes, so a gate
    // that read approval from the session would keep this account working for
    // five more minutes after an operator revoked it.
    await setApproval("REJECTED");

    await expect(requireSession()).rejects.toBeInstanceOf(ForbiddenError);
    expect(await getSession()).toBeNull();
  });
});
