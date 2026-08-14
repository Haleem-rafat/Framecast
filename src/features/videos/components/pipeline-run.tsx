"use client";

import { LogStream } from "@/features/videos/components/log-stream";
import {
  PipelinePanel,
  PipelineSummary,
  usePipelineState,
} from "@/features/videos/components/pipeline-panel";
import { VideoSection } from "@/features/videos/components/video-section";
import type {
  PipelineLogStream,
  PipelineState,
} from "@/services/pipeline.service";

/**
 * The run, as one section: stages down the left, the log for the run beside
 * them on the right.
 *
 * This exists as its own client component for one reason — the section's
 * header has to be live. A folded pipeline section whose header still reads
 * "Queued" ten minutes into a render is worse than no header at all, and the
 * only way for the header to know is to subscribe to the same pipeline query
 * the panel does. That subscription cannot happen in the page, which is a
 * server component, and it cannot happen in `PipelinePanel`, which is *inside*
 * the section it would need to describe. So the composition lives here, one
 * level up from both, and reads the query itself.
 *
 * Subscribing a third time costs nothing: React Query keys one underlying
 * query and one scheduled refetch by `queryKey`, so the header, the panel and
 * the log stream are three observers of a single poll (see `usePipelineState`).
 *
 * Stacked, the log used to sit below a panel tall enough to push it off
 * screen, so watching a render meant scrolling down to the output and back up
 * to see which stage produced it — the two halves of one question, kept apart.
 * It collapses back to a single column below `lg`, where side by side would
 * give the log about forty characters a line and make it unreadable.
 */
export function PipelineRun({
  videoId,
  initialState,
  initialLogs,
  defaultOpen,
}: {
  videoId: string;
  initialState: PipelineState;
  initialLogs: PipelineLogStream;
  defaultOpen: boolean;
}) {
  const { data } = usePipelineState(videoId, initialState);
  const state = data ?? initialState;

  return (
    <VideoSection
      id="pipeline"
      title="Pipeline"
      summary={
        <PipelineSummary videoId={videoId} initialState={initialState} />
      }
      defaultOpen={defaultOpen}
      // The one section on the page that can start moving on its own while
      // folded. `isActive` is the server's own "something is genuinely in
      // flight" flag, and `isFinalizing` is the window right after a render
      // succeeds where metadata and thumbnail are still generating — both are
      // runs an operator should not have to unfold to discover.
      active={state.isActive || state.isFinalizing}
      bodyClassName="grid gap-4 lg:grid-cols-5"
    >
      <div className="lg:col-span-2">
        <PipelinePanel videoId={videoId} initialState={initialState} />
      </div>
      <div className="lg:col-span-3">
        <LogStream
          videoId={videoId}
          initialLogs={initialLogs}
          initialPipelineState={initialState}
        />
      </div>
    </VideoSection>
  );
}
