"use server";

import { run, type ActionResult } from "@/actions/action-result";
import { requireSession } from "@/server/session";
import { searchService, type SearchResponse } from "@/services/search.service";

/**
 * The command palette's only way into the database.
 *
 * `requireSession()` is what makes the scoping in `search.service.ts` mean
 * anything: the user id handed to the service comes from the signed-in
 * session and never from the caller's arguments, so there is no parameter an
 * operator could tamper with to search somebody else's library. Notably there
 * is no `revalidatePath` here — this reads and changes nothing, and busting
 * the router cache on every keystroke would be its own kind of denial of
 * service.
 */
export async function searchAction(
  query: string,
): Promise<ActionResult<SearchResponse>> {
  return run(async () => {
    const session = await requireSession();

    return searchService.search(session.user.id, query);
  });
}
