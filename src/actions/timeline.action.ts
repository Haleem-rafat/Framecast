"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import { requireSession } from "@/server/session";
import { timelineService, type FootageOption } from "@/services/timeline.service";
import type { StockFootageSource } from "@/services/providers/types";

/**
 * Candidate clips for one section, from the same Pexels/Pixabay clients
 * collection uses.
 *
 * Read-only, so no `revalidatePath` — re-rendering the whole video route
 * because somebody typed in a search box would throw away the timeline they
 * are looking at, and the picker's results are local to the dialog anyway.
 *
 * Costs one search against each provider per call, which is why the dialog
 * searches on submit rather than on every keystroke: Pexels allows 200 an
 * hour, shared with every video's footage collection.
 */
export async function searchSectionFootageAction(
  videoId: string,
  query: string,
): Promise<ActionResult<FootageOption[]>> {
  return run(async () => {
    const session = await requireSession();
    return timelineService.searchFootage(session.user.id, videoId, query);
  });
}

/**
 * Puts a different clip under one section.
 *
 * Writes storage and a row; it does not touch the finished MP4, and nothing
 * here pretends otherwise — the render is only rebuilt when the pipeline runs
 * again from the Pipeline tab. `TimelineService.swapFootage` refuses outright
 * when no run is still ahead of this video, so a choice that could never be
 * read is never stored.
 *
 * `revalidatePath` on the video's own route is what redraws the timeline with
 * the new clip: the panel is handed its data by a server component, so a
 * refresh is the whole update path — there is no client cache to reconcile.
 * `/videos` is left alone deliberately; the list shows nothing that a footage
 * swap changes.
 *
 * `source` and `externalId` name the clip; the URL is never accepted from the
 * browser. The service re-runs `query` against that provider and matches on
 * `externalId`, so the bytes it downloads always come from a URL the provider
 * itself just returned — see `downloadClip`'s comment for why that matters.
 */
export async function swapSectionFootageAction(
  videoId: string,
  args: {
    sectionIndex: number;
    source: StockFootageSource;
    externalId: string;
    query: string;
  },
): Promise<ActionResult<{ provider: StockFootageSource; externalId: string; sizeBytes: number }>> {
  return run(async () => {
    const session = await requireSession();
    const result = await timelineService.swapFootage(session.user.id, videoId, args);

    revalidatePath(`/videos/${videoId}`);

    return result;
  });
}
