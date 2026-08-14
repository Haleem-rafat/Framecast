"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import { requireSession } from "@/server/session";
import { studioService, type ScriptVersionContent } from "@/services/studio.service";

/**
 * Fetches one script's narration for the library's reader.
 *
 * Read-only, so no `revalidatePath` — re-rendering the whole route because
 * somebody opened a dialog would throw away the list they are reading.
 */
export async function readScriptVersionAction(
  versionId: string,
): Promise<ActionResult<ScriptVersionContent>> {
  return run(async () => {
    const session = await requireSession();
    return studioService.readScriptVersion(session.user.id, versionId);
  });
}

export async function setActiveThumbnailVersionAction(
  videoId: string,
  versionId: string,
): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    await studioService.setActiveThumbnailVersion(session.user.id, videoId, versionId);

    // Both surfaces show the active version: the gallery here and the
    // publish confirmation on the video's own page.
    revalidatePath("/studio/thumbnail");
    revalidatePath(`/videos/${videoId}`);

    return null;
  });
}

/**
 * Spends money: one image generation through the AI gateway plus an FFmpeg
 * composite, every time it is called.
 *
 * The refusals that make the spend pointless — an already-published video, a
 * video with no active script — live in `StudioService.regenerateThumbnail`
 * and run before the provider is reached. This action adds nothing to them;
 * the UI's own confirmation is what stops an accidental click, and the
 * service is what stops a crafted one.
 */
export async function regenerateThumbnailAction(
  videoId: string,
): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    await studioService.regenerateThumbnail(session.user.id, videoId);

    revalidatePath("/studio/thumbnail");
    revalidatePath(`/videos/${videoId}`);

    return null;
  });
}
