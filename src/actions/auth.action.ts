"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import { requireOperatorSession } from "@/server/session";
import { accountService } from "@/services/account.service";

/**
 * Deciding somebody else's registration is an operator's job, and until this
 * gate existed these two actions asked only for `requireSession()`.
 *
 * That was true enough while Framecast was one private account: the approval
 * gate lives inside `requireSession()`, so passing it meant "an approved
 * account", and there was exactly one of those. Registration then opened. With
 * 41 approved accounts the same line meant any of them could approve or reject
 * anyone — including approving an account they had just registered themselves.
 * Nothing about the code changed; what it asserted quietly stopped being true.
 *
 * `requireOperatorSession()` asks the question the actions actually mean. It
 * refuses a member with the same bare 401 a request carrying no cookie gets,
 * so a POST crafted straight at this endpoint cannot even confirm it exists —
 * see its comment in src/server/session.ts. `accountService.decide` re-reads
 * the caller's role at the write itself and refuses again.
 */
export async function approveAccountAction(
  userId: string,
): Promise<ActionResult<Awaited<ReturnType<typeof accountService.approve>>>> {
  return run(async () => {
    const session = await requireOperatorSession();
    const account = await accountService.approve(session.user.id, userId);

    revalidatePath("/approvals");

    return account;
  });
}

export async function rejectAccountAction(
  userId: string,
): Promise<ActionResult<Awaited<ReturnType<typeof accountService.reject>>>> {
  return run(async () => {
    const session = await requireOperatorSession();
    const account = await accountService.reject(session.user.id, userId);

    revalidatePath("/approvals");

    return account;
  });
}
