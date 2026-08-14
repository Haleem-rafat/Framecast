import "server-only";

import type { AccountApproval } from "@/generated/prisma/enums";
import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

/**
 * Anyone may register, but a new account sits in `PENDING` until an operator
 * who is already `APPROVED` acts on it. This service owns both halves of that:
 * the read the session gate makes on every request, and the two writes that
 * move an account out of the queue.
 *
 * It deliberately takes no `Session` and no cookies — callers pass ids. That
 * keeps it callable from the approvals action, from a script, and from tests
 * without any of them having to fake a request.
 */

/** Shape the approvals queue renders. No password/session data, by construction. */
export interface PendingAccount {
  id: string;
  name: string;
  email: string;
  image: string | null;
  createdAt: Date;
}

const PENDING_ACCOUNT_SELECT = {
  id: true,
  name: true,
  email: true,
  image: true,
  createdAt: true,
} as const;

export class AccountService {
  /**
   * The gate's read (see src/server/session.ts). Returns `null` when the row
   * is gone — a session whose user has been deleted must fail closed, not fall
   * through to "no approval recorded, must be fine".
   */
  async approvalFor(userId: string): Promise<AccountApproval | null> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { approval: true },
    });

    return user?.approval ?? null;
  }

  /**
   * Oldest first: the queue is a FIFO of people waiting, and burying the
   * longest-waiting request under newer ones is exactly the failure mode the
   * `[approval, createdAt]` index exists to make cheap to avoid.
   */
  async listPending(): Promise<PendingAccount[]> {
    return prisma.user.findMany({
      where: { approval: "PENDING" },
      orderBy: { createdAt: "asc" },
      select: PENDING_ACCOUNT_SELECT,
    });
  }

  async approve(approverId: string, userId: string): Promise<PendingAccount> {
    return this.decide(approverId, userId, "APPROVED");
  }

  async reject(approverId: string, userId: string): Promise<PendingAccount> {
    return this.decide(approverId, userId, "REJECTED");
  }

  /**
   * Records that a password reset link was issued.
   *
   * There is no email transport in this deployment (see
   * `PASSWORD_RESET_DELIVERY` in src/config/env.ts), so this row *is* the
   * delivery mechanism: an operator reads the link out of the activity log and
   * passes it to the person who asked. It is logged at WARN precisely so it
   * stands out as something a human still has to do — an INFO row would scroll
   * past unnoticed and the reset would simply never arrive.
   *
   * The consequence, stated plainly: anyone who can read the activity log can
   * take over any account by following one of these links before it expires.
   * Today that is only approved operators, which is the same set of people who
   * can approve accounts anyway. It stops being acceptable the moment this
   * studio has operators who should not be able to impersonate each other.
   */
  async recordPasswordResetRequest(input: {
    userId: string;
    email: string;
    url: string;
    expiresAt: Date;
  }): Promise<void> {
    await prisma.activityLog.create({
      data: {
        userId: input.userId,
        level: "WARN",
        action: "auth.passwordReset.requested",
        entityType: "User",
        entityId: input.userId,
        message:
          `Password reset requested for ${input.email}. No email was sent — ` +
          "this deployment has no email transport. Relay the link below to " +
          `the account holder before ${input.expiresAt.toISOString()}.`,
        metadata: {
          resetUrl: input.url,
          expiresAt: input.expiresAt.toISOString(),
          delivery: "activity-log",
        },
      },
    });
  }

  /** Closes the loop on the row above, so an unused link is visible as unused. */
  async recordPasswordResetCompleted(input: {
    userId: string;
    email: string;
  }): Promise<void> {
    await prisma.activityLog.create({
      data: {
        userId: input.userId,
        action: "auth.passwordReset.completed",
        entityType: "User",
        entityId: input.userId,
        message: `Password reset completed for ${input.email}. All other sessions were signed out.`,
      },
    });
  }

  /**
   * The single write path for both decisions.
   *
   * Two things are load-bearing here:
   *
   * 1. The approver's own status is re-read from the database rather than
   *    trusted from the caller. The action layer already gates on
   *    `requireSession()`, but this service is the security boundary the rest
   *    of the codebase relies on, and "only an approved operator may approve"
   *    is worth enforcing where the write actually happens.
   *
   * 2. The update is conditional on the row still being `PENDING`
   *    (`updateMany` with the status in the `where`, not `update` by id). Two
   *    operators opening the queue at the same time and clicking opposite
   *    buttons is entirely plausible; without the condition the second write
   *    would silently overwrite the first decision and stamp a fresh
   *    `approvedAt`. With it, exactly one of them wins and the loser gets a
   *    `ConflictError` telling them the account was already decided.
   */
  private async decide(
    approverId: string,
    userId: string,
    decision: Extract<AccountApproval, "APPROVED" | "REJECTED">,
  ): Promise<PendingAccount> {
    if (approverId === userId) {
      throw new ForbiddenError("You cannot decide on your own account.");
    }

    if ((await this.approvalFor(approverId)) !== "APPROVED") {
      throw new ForbiddenError(
        "Only an approved operator can decide on other accounts.",
      );
    }

    const account = await prisma.user.findUnique({
      where: { id: userId },
      select: PENDING_ACCOUNT_SELECT,
    });

    if (!account) {
      throw new NotFoundError("Account");
    }

    const { count } = await prisma.user.updateMany({
      where: { id: userId, approval: "PENDING" },
      data: {
        approval: decision,
        // Only an approval is a moment worth keeping. A rejection leaves
        // `approvedAt` null so "when was this account cleared to work" has one
        // answer and never a misleading one.
        ...(decision === "APPROVED" ? { approvedAt: new Date() } : {}),
      },
    });

    if (count === 0) {
      throw new ConflictError(
        `${account.email} has already been decided by another operator.`,
      );
    }

    await prisma.activityLog.create({
      data: {
        // Attributed to the operator who made the call, not to the account it
        // was made about — the log answers "who let this person in".
        userId: approverId,
        level: decision === "APPROVED" ? "INFO" : "WARN",
        action: decision === "APPROVED" ? "account.approve" : "account.reject",
        entityType: "User",
        entityId: userId,
        message: `${decision === "APPROVED" ? "Approved" : "Rejected"} ${account.email}`,
      },
    });

    return account;
  }
}

export const accountService = new AccountService();
