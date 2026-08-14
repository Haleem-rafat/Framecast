"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import { requireSession } from "@/server/session";
import { accountService } from "@/services/account.service";

/**
 * `requireSession()` is doing double duty here: it establishes who is calling
 * *and*, since the approval gate lives inside it, that the caller is an
 * approved operator. A pending account POSTing straight at this endpoint gets
 * a 403 before `accountService` is reached — and is refused a second time by
 * the service itself, which re-reads the approver's status.
 */
export async function approveAccountAction(
  userId: string,
): Promise<ActionResult<Awaited<ReturnType<typeof accountService.approve>>>> {
  return run(async () => {
    const session = await requireSession();
    const account = await accountService.approve(session.user.id, userId);

    revalidatePath("/approvals");

    return account;
  });
}

export async function rejectAccountAction(
  userId: string,
): Promise<ActionResult<Awaited<ReturnType<typeof accountService.reject>>>> {
  return run(async () => {
    const session = await requireSession();
    const account = await accountService.reject(session.user.id, userId);

    revalidatePath("/approvals");

    return account;
  });
}
