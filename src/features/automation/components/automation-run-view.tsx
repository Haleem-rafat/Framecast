"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { ExternalLink, ShieldCheck, Sparkles } from "lucide-react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PipelineLoader } from "@/features/automation/components/pipeline-loader";
import { PipelinePanel, usePipelineState } from "@/features/videos/components/pipeline-panel";
import type { AutomationRun } from "@/services/automation.service";
import type { PipelineState } from "@/services/pipeline.service";

/**
 * Everything the operator sees once the run is under way.
 *
 * Both props are resolved on the server by the page, and the run itself is
 * addressed by URL (`/automation/generate?video=…`) rather than held in state, so
 * closing the tab and coming back re-reads the truth instead of losing it.
 * From there `usePipelineState` — the same hook, the same query key and the
 * same polling cadence the video detail page uses — keeps it current. There is
 * no second progress system here, only a second *view* of the one there
 * already was.
 */
export function AutomationRunView({
  run,
  initialState,
}: {
  run: AutomationRun;
  initialState: PipelineState;
}) {
  const router = useRouter();
  const { data } = usePipelineState(run.videoId, initialState);
  const state = data ?? initialState;

  /**
   * Whether the run was already over when this view mounted.
   *
   * The finish is a navigation to the video's own page — that is where a
   * finished video lives, and it is the natural end of the flow. But an
   * operator who *opens* an already-finished run (a bookmarked URL, a tab left
   * open overnight) has not just watched it finish, and redirecting them the
   * instant the page paints would look like a broken link. So the redirect
   * fires only on the transition, and an arrival at an already-finished run
   * gets a button instead.
   */
  const wasFinishedOnArrival = useRef(initialState.isTerminal && !initialState.isFailed);
  const hasNavigated = useRef(false);

  const isFinished = state.isTerminal && !state.isFailed;

  useEffect(() => {
    if (!isFinished || wasFinishedOnArrival.current || hasNavigated.current) return;

    hasNavigated.current = true;
    // `replace`, not `push`: the run is over, and a Back button that returns to
    // a progress page for a finished video is a dead end.
    router.replace(`/videos/${run.videoId}`);
  }, [isFinished, router, run.videoId]);

  return (
    <div className="space-y-4">
      {run.autoApproved && (
        <Alert>
          <ShieldCheck />
          <AlertTitle>Script written and approved for you</AlertTitle>
          <AlertDescription>
            {run.scriptVersion !== null && run.wordCount !== null
              ? `Framecast generated version ${run.scriptVersion} (${run.wordCount} words) from your default script prompt and approved it on your behalf, which is what put the video in the render queue without a second click. Read it below.`
              : "Framecast generated this script from your default script prompt and approved it on your behalf, which is what put the video in the render queue without a second click."}
            <p className="mt-2">
              <strong className="text-foreground font-medium">
                Nothing is published.
              </strong>{" "}
              The run ends at a finished video you can watch. Sending it to
              YouTube is still a separate, deliberate click on the video&apos;s
              own page.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {run.scriptContent && (
        <Card>
          <CardContent>
            <Accordion type="single" collapsible>
              <AccordionItem value="script" className="border-none">
                <AccordionTrigger className="py-0 text-sm hover:no-underline">
                  {/* Collapsed by default: the operator chose not to read the
                      script up front, so this offers it rather than insisting. */}
                  Read the approved script
                  {run.scriptVersion !== null ? ` — v${run.scriptVersion}` : ""}
                  {run.wordCount !== null ? `, ${run.wordCount} words` : ""}
                </AccordionTrigger>
                <AccordionContent>
                  <pre className="bg-muted/50 mt-2 max-h-96 overflow-y-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap">
                    {run.scriptContent}
                  </pre>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </CardContent>
        </Card>
      )}

      {/* The at-a-glance view: which stage the AI is on right now. */}
      <PipelineLoader state={state} hasScript={run.scriptContent !== null} />

      {/* The detailed one, shared with the video detail page: per-stage detail,
          the render log tail, the queue diagnosis when nothing has claimed the
          video, and the Cancel/Retry controls. Everything the step list above
          is too small to say, already written and already correct. */}
      <PipelinePanel videoId={run.videoId} initialState={state} />

      <div className="flex flex-wrap items-center gap-2">
        <Button asChild>
          <Link href={`/videos/${run.videoId}`}>
            <ExternalLink />
            {isFinished ? `Watch ${run.title}` : `Open ${run.title}`}
          </Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/automation/generate">
            <Sparkles />
            Start another
          </Link>
        </Button>
        <p className="text-muted-foreground text-xs">
          Rendering runs on its own machine — you can close this page and come
          back.
        </p>
      </div>
    </div>
  );
}
