import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

/**
 * The privilege escalation, tested at the endpoint a browser actually reaches.
 *
 * `src/server/session.test.ts` proves `requireOperatorSession()` refuses a
 * member. This file proves the two account actions are *wired to it* — which
 * is the half that was broken. Nothing about those functions' bodies changed
 * when registration opened; only the meaning of the gate they were already
 * calling did, and a test of the gate alone would have stayed green through
 * the entire vulnerable period.
 *
 * So the mocks stop at Better Auth and Next's request context, exactly as the
 * session test's do. Everything below that — the session module, the role
 * read, `accountService.decide`, Postgres — is real.
 */
const getSessionMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: getSessionMock } },
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const { approveAccountAction, rejectAccountAction } = await import(
  "@/actions/auth.action"
);

let operatorId: string;
let memberId: string;
let applicantId: string;

function signedInAs(id: string) {
  return {
    session: { id: randomUUID(), userId: id },
    user: {
      id,
      name: "Test Account",
      email: `test-${id}@framecast.invalid`,
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

beforeEach(async () => {
  operatorId = await createTestUser("action-operator");
  memberId = await createTestUser("action-member");
  applicantId = await createTestUser("action-applicant");

  await prisma.user.update({
    where: { id: operatorId },
    data: { approval: "APPROVED", approvedAt: new Date(), role: "OPERATOR" },
  });
  // APPROVED, MEMBER — the state of all 41 accounts in production, and the
  // state that used to be enough to approve anybody.
  await prisma.user.update({
    where: { id: memberId },
    data: { approval: "APPROVED", approvedAt: new Date() },
  });

  getSessionMock.mockReset();
});

afterEach(async () => {
  await deleteTestUser(applicantId);
  await deleteTestUser(memberId);
  await deleteTestUser(operatorId);
});

describe("approveAccountAction", () => {
  it("lets an operator approve a waiting account", async () => {
    getSessionMock.mockResolvedValue(signedInAs(operatorId));

    const result = await approveAccountAction(applicantId);

    expect(result.ok).toBe(true);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: applicantId } }))
        .approval,
    ).toBe("APPROVED");
  });

  it("refuses an approved MEMBER, and the applicant is still waiting", async () => {
    getSessionMock.mockResolvedValue(signedInAs(memberId));

    const result = await approveAccountAction(applicantId);

    expect(result.ok).toBe(false);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: applicantId } }))
        .approval,
    ).toBe("PENDING");
  });

  it("tells a MEMBER exactly what it tells a request carrying no cookie at all", async () => {
    getSessionMock.mockResolvedValue(null);
    const asStranger = await approveAccountAction(applicantId);

    getSessionMock.mockResolvedValue(signedInAs(memberId));
    const asMember = await approveAccountAction(applicantId);

    // Identical serialized error, not merely both failures. A member who
    // POSTs at this endpoint must not be able to tell from the response that
    // it exists and that they are one flag away from it.
    expect(asMember).toEqual(asStranger);
    expect(asMember.ok).toBe(false);
    if (!asMember.ok) expect(asMember.error.code).toBe("UNAUTHORIZED");
  });
});

describe("rejectAccountAction", () => {
  it("lets an operator reject a waiting account", async () => {
    getSessionMock.mockResolvedValue(signedInAs(operatorId));

    const result = await rejectAccountAction(applicantId);

    expect(result.ok).toBe(true);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: applicantId } }))
        .approval,
    ).toBe("REJECTED");
  });

  it("refuses an approved MEMBER, and the applicant is still waiting", async () => {
    getSessionMock.mockResolvedValue(signedInAs(memberId));

    const result = await rejectAccountAction(applicantId);

    expect(result.ok).toBe(false);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: applicantId } }))
        .approval,
    ).toBe("PENDING");
  });

  it("tells a MEMBER exactly what it tells a request carrying no cookie at all", async () => {
    getSessionMock.mockResolvedValue(null);
    const asStranger = await rejectAccountAction(applicantId);

    getSessionMock.mockResolvedValue(signedInAs(memberId));
    const asMember = await rejectAccountAction(applicantId);

    expect(asMember).toEqual(asStranger);
  });
});
