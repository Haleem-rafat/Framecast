import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { accountService } from "@/services/account.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

// Tests run against a real, shared Postgres database (see src/test/setup.ts)
// that also holds the operator's real data — including their real, APPROVED
// account. Every test here gets its own throwaway users (see
// src/test/fixtures.ts), and every assertion about the pending queue is made
// against *this file's* ids rather than the raw list, because listPending()
// legitimately returns every waiting account in the database and the operator
// may have real ones.
//
// createTestUser() writes no `approval`, so its users take the column's
// PENDING default — which is exactly the state the queue is about.

let approverId: string;
let applicantId: string;

beforeEach(async () => {
  approverId = await createTestUser("approver");
  applicantId = await createTestUser("applicant");

  // The approver has to be an APPROVED OPERATOR to decide anything. A freshly
  // created row is PENDING and MEMBER, like everyone who registers — which is
  // the whole point of the role: being approved is no longer enough.
  await prisma.user.update({
    where: { id: approverId },
    data: { approval: "APPROVED", approvedAt: new Date(), role: "OPERATOR" },
  });
});

afterEach(async () => {
  await deleteTestUser(applicantId);
  await deleteTestUser(approverId);
});

describe("accountService.approvalFor", () => {
  it("reports the default state of a newly registered account as PENDING", async () => {
    expect(await accountService.approvalFor(applicantId)).toBe("PENDING");
  });

  it("returns null for an id with no row, so the gate fails closed", async () => {
    // A session can outlive the user it points at. "No row" must never read
    // as "nothing recorded against them, let them in".
    expect(await accountService.approvalFor(randomUUID())).toBeNull();
  });
});

describe("accountService.listPending", () => {
  it("lists waiting accounts oldest first", async () => {
    // A second applicant, deliberately backdated, has to come out in front of
    // the one created a moment ago in beforeEach — ordering must follow
    // createdAt, not insertion order or id.
    const olderId = await createTestUser("older-applicant");

    try {
      await prisma.user.update({
        where: { id: olderId },
        data: { createdAt: new Date("2020-01-01T00:00:00.000Z") },
      });

      const queue = await accountService.listPending();
      const ours = queue
        .map((account) => account.id)
        .filter((id) => id === olderId || id === applicantId);

      expect(ours).toEqual([olderId, applicantId]);
    } finally {
      await deleteTestUser(olderId);
    }
  });

  it("drops an account from the queue once it is decided", async () => {
    await accountService.approve(approverId, applicantId);

    const queue = await accountService.listPending();
    expect(queue.map((account) => account.id)).not.toContain(applicantId);
  });

  it("hands back no more than the queue needs to render", async () => {
    const queue = await accountService.listPending();
    const entry = queue.find((account) => account.id === applicantId);

    expect(entry).toBeDefined();
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      "createdAt",
      "email",
      "id",
      "image",
      "name",
    ]);
  });
});

describe("accountService.approve", () => {
  it("moves the account to APPROVED and stamps approvedAt", async () => {
    const before = Date.now();

    await accountService.approve(approverId, applicantId);

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: applicantId },
      select: { approval: true, approvedAt: true },
    });
    expect(row.approval).toBe("APPROVED");
    expect(row.approvedAt).not.toBeNull();
    expect(row.approvedAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("records who let them in, not who was let in", async () => {
    await accountService.approve(approverId, applicantId);

    const log = await prisma.activityLog.findFirstOrThrow({
      where: { action: "account.approve", entityId: applicantId },
    });
    expect(log.userId).toBe(approverId);
  });

  it("refuses an approver who is not approved themselves", async () => {
    const outsiderId = await createTestUser("outsider");

    try {
      // The action layer already gates on requireOperatorSession(), which
      // enforces this too — but the service is the boundary the rest of the
      // codebase trusts, so it must not depend on the caller having checked.
      await expect(
        accountService.approve(outsiderId, applicantId),
      ).rejects.toBeInstanceOf(ForbiddenError);

      expect(await accountService.approvalFor(applicantId)).toBe("PENDING");
    } finally {
      await deleteTestUser(outsiderId);
    }
  });

  it("refuses to let an account decide on itself", async () => {
    await expect(
      accountService.approve(applicantId, applicantId),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses an account that does not exist", async () => {
    await expect(
      accountService.approve(approverId, randomUUID()),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("accountService.reject", () => {
  it("moves the account to REJECTED and leaves approvedAt unset", async () => {
    await accountService.reject(approverId, applicantId);

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: applicantId },
      select: { approval: true, approvedAt: true },
    });
    expect(row.approval).toBe("REJECTED");
    // "When was this account cleared to work" must have exactly one answer.
    expect(row.approvedAt).toBeNull();
  });
});

/**
 * The escalation this column was added to close, asserted at the write itself.
 *
 * Until `role` existed, `decide` required only that the caller was APPROVED.
 * That meant "is the owner" while Framecast was one private account, and
 * "is any one of 41 strangers who registered" once registration opened. The
 * action layer gates first, but this is the boundary a script or a future
 * route handler would land on, so it must refuse on its own.
 */
describe("an approved MEMBER trying to decide someone else's account", () => {
  let memberId: string;

  beforeEach(async () => {
    memberId = await createTestUser("member");
    await prisma.user.update({
      where: { id: memberId },
      // APPROVED and MEMBER: exactly the state of every production account.
      data: { approval: "APPROVED", approvedAt: new Date() },
    });
  });

  afterEach(() => deleteTestUser(memberId));

  it("is a MEMBER by default, with no migration having said otherwise", async () => {
    expect(await accountService.roleFor(memberId)).toBe("MEMBER");
  });

  it("is refused by approve, and the applicant stays PENDING", async () => {
    await expect(
      accountService.approve(memberId, applicantId),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(await accountService.approvalFor(applicantId)).toBe("PENDING");
  });

  it("is refused by reject, and the applicant stays PENDING", async () => {
    await expect(
      accountService.reject(memberId, applicantId),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(await accountService.approvalFor(applicantId)).toBe("PENDING");
  });

  it("leaves no decision log behind, so a refused attempt cannot look like a decision", async () => {
    await expect(
      accountService.approve(memberId, applicantId),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const logs = await prisma.activityLog.count({
      where: { entityId: applicantId, action: { startsWith: "account." } },
    });
    expect(logs).toBe(0);
  });

  it("cannot promote itself either — roleFor is a read, and nothing here writes it", async () => {
    // There is no service method that grants OPERATOR. The only path is
    // scripts/promote-operator.ts, run by hand at the server.
    expect(
      Object.getOwnPropertyNames(Object.getPrototypeOf(accountService)),
    ).not.toContain("promote");
  });
});

describe("accountService.roleFor", () => {
  it("returns null for an id with no row, so the operator gate fails closed", async () => {
    expect(await accountService.roleFor(randomUUID())).toBeNull();
  });

  it("reads OPERATOR once an account has been promoted", async () => {
    expect(await accountService.roleFor(approverId)).toBe("OPERATOR");
  });
});

describe("two operators deciding the same account", () => {
  it("lets the first decision stand and tells the second it lost", async () => {
    const secondApproverId = await createTestUser("approver-2");

    try {
      await prisma.user.update({
        where: { id: secondApproverId },
        data: {
          approval: "APPROVED",
          approvedAt: new Date(),
          role: "OPERATOR",
        },
      });

      await accountService.approve(approverId, applicantId);

      // The realistic race: two operators had the queue open, one clicked
      // Approve, the other clicked Reject a moment later. The second write is
      // conditional on the row still being PENDING, so it cannot silently
      // overwrite a decision that has already been made.
      await expect(
        accountService.reject(secondApproverId, applicantId),
      ).rejects.toBeInstanceOf(ConflictError);

      expect(await accountService.approvalFor(applicantId)).toBe("APPROVED");
    } finally {
      await deleteTestUser(secondApproverId);
    }
  });

  it("writes one decision log, not one per click", async () => {
    await accountService.approve(approverId, applicantId);
    await expect(
      accountService.approve(approverId, applicantId),
    ).rejects.toBeInstanceOf(ConflictError);

    // The losing click must not leave a second "approved" row behind claiming
    // the decision happened twice.
    const logs = await prisma.activityLog.count({
      where: { entityId: applicantId, action: { startsWith: "account." } },
    });
    expect(logs).toBe(1);
  });
});

describe("password reset without an email transport", () => {
  it("writes the link where an operator can find it, and says no email was sent", async () => {
    const url = `https://framecast.test/api/auth/reset-password/${randomUUID()}?callbackURL=%2Freset-password`;
    const expiresAt = new Date(Date.now() + 7200 * 1000);

    await accountService.recordPasswordResetRequest({
      userId: applicantId,
      email: "applicant@framecast.invalid",
      url,
      expiresAt,
    });

    const log = await prisma.activityLog.findFirstOrThrow({
      where: { userId: applicantId, action: "auth.passwordReset.requested" },
    });

    // WARN, not INFO: this row is a task for a human, and an INFO row scrolls
    // past unread while someone waits for an email that will never arrive.
    expect(log.level).toBe("WARN");
    expect(log.message).toContain("No email was sent");
    expect(log.metadata).toMatchObject({
      resetUrl: url,
      delivery: "activity-log",
    });
  });
});
