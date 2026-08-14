import type { Metadata } from "next";
import Link from "next/link";
import { CalendarClock } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { AutomationFlow } from "@/features/automation/components/automation-flow";
import { AutomationRunView } from "@/features/automation/components/automation-run-view";
import { ReadinessNotice } from "@/features/automation/components/readiness-notice";
import { requireUser } from "@/server/session";
import { automationService } from "@/services/automation.service";
import { pipelineService } from "@/services/pipeline.service";

export const metadata: Metadata = { title: "Automation" };

interface AutomationPageProps {
  /** `?video=<id>` addresses a run already under way — see below. */
  searchParams: Promise<{ video?: string }>;
}

/**
 * The guided alternative to the step-by-step UI.
 *
 * Two states, and which one renders is decided by the URL rather than by
 * component state. `?video=<id>` is a run in progress: a render takes minutes
 * on a worker that keeps going whether or not the tab is open, so the progress
 * view has to be something an operator can navigate away from and come back to.
 * Putting the id in the query string makes that free — the state is re-read
 * here, on the server, on every arrival.
 *
 * No Suspense boundary. Both branches are a handful of indexed lookups, and
 * the flow's first question depends on the answer to "can this account run at
 * all", so streaming a shell that might be replaced by a refusal would be
 * worse than waiting a few milliseconds for the real one.
 */
export default async function AutomationPage({ searchParams }: AutomationPageProps) {
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

  const setup = await automationService.getSetup(user.id);

  return (
    <>
      <PageHeader
        title="One-click video"
        description="Answer a few questions and Framecast writes the script, approves it for you, and runs the pipeline through to a finished video. Publishing stays yours."
        actions={
          /* The same flow, on a timer. Surfaced here rather than in the sidebar
             because a schedule is not a separate feature — it is this page's
             own button, pressed for you every Monday — and finding it beside
             the manual version is what makes that relationship obvious. */
          <Button asChild variant="outline">
            <Link href="/automation/schedules">
              <CalendarClock />
              Schedules
            </Link>
          </Button>
        }
      />

      {/* `prompt` is null exactly when the missing-default-prompt blocker is
          present, so this branch covers both conditions the flow cannot run
          without — and the type narrows for free rather than needing an
          assertion. */}
      {setup.blockers.length > 0 || !setup.prompt ? (
        <ReadinessNotice blockers={setup.blockers} />
      ) : (
        <AutomationFlow projects={setup.projects} prompt={setup.prompt} />
      )}
    </>
  );
}
