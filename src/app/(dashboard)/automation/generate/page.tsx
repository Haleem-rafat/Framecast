import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/shared/page-header";
import { AutomationRunView } from "@/features/automation/components/automation-run-view";
import { requireUser } from "@/server/session";
import { automationService } from "@/services/automation.service";
import { pipelineService } from "@/services/pipeline.service";

export const metadata: Metadata = { title: "One-click video" };

interface GeneratePageProps {
  /** `?video=<id>` addresses a run already under way — see below. */
  searchParams: Promise<{ video?: string }>;
}

/**
 * Make one video, now.
 *
 * ## Why this has a route of its own
 *
 * It used to be `/automation` itself, with links out to series and schedules.
 * That was the wrong shape: this page is not a kind of automation, it is the
 * opposite of one. Everything at `/automation` now describes something that
 * happens repeatedly without anybody present; this describes one video the
 * operator wants *this afternoon*. Putting a one-shot action at the top of a
 * screen about recurrence was a large part of why the three screens read as
 * variations on each other.
 *
 * It stays one click from there — the primary action in the automations header
 * — and keeps its slot in the sidebar and the ⌘K palette under its own name,
 * because "make a video right now" is the thing an operator most often opens
 * this product to do.
 *
 * ## Two states, decided by the URL
 *
 * `?video=<id>` is a run in progress: a render takes minutes on a worker that
 * keeps going whether or not the tab is open, so the progress view has to be
 * something an operator can navigate away from and come back to. Putting the id
 * in the query string makes that free — the state is re-read here, on the
 * server, on every arrival. It is also the URL a series' "Make one now" sends
 * them to, so a video made from a show and a video made by hand are watched on
 * the same screen.
 *
 * No Suspense boundary. Both branches are a handful of indexed lookups, and the
 * flow's first question depends on the answer to "can this account run at all",
 * so streaming a shell that might be replaced by a refusal would be worse than
 * waiting a few milliseconds for the real one.
 */
export default async function GeneratePage({ searchParams }: GeneratePageProps) {
  const user = await requireUser();
  const { video: videoId } = await searchParams;

  if (videoId) {
    const run = await automationService.getRun(user.id, videoId);

    // A missing or foreign id falls through to the normal starting state
    // rather than erroring: the query string is operator-editable, and this
    // way a stale link is simply a fresh flow instead of a dead end.
    if (run) {
      const state = await pipelineService.getState(user.id, run.videoId);

      return (
        <>
          <PageHeader
            title="Generating your video"
            description="The script is written and approved. Narration, footage and the render run on their own machine — you can close this page and come back."
          />
          <AutomationRunView run={run} initialState={state} />
        </>
      );
    }
  }

  // One call, not two. `EasyModeService.getSetup` composes
  // `AutomationService.getSetup` internally, so the blockers, the projects and
  // the prompt behind both modes are read once and cannot disagree — the
  // failure a second independent call would eventually produce is a page whose
  // easy tab says the account is ready and whose written tab says it is not.
  // Making one video now is a tab of the Automation page; this address only
  // still shows a run in progress (?video=) and forwards everything else.
  redirect("/automation?tab=make");
}
