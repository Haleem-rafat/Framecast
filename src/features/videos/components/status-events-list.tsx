import { RelativeTime } from "@/components/shared/relative-time";
import { VideoStatusBadge } from "@/features/videos/components/video-status-badge";
import type { VideoStatus } from "@/generated/prisma/enums";

interface StatusEvent {
  id: string;
  from: VideoStatus | null;
  to: VideoStatus;
  message: string | null;
  createdAt: Date;
}

/**
 * The video's status history.
 *
 * Renders bare — no card of its own. Every block on the video detail page is
 * wrapped in one collapsible `VideoSection`, which supplies the surface and
 * the heading; a card inside that section would be a card inside a card, and a
 * second "Recent activity" title under the section's own.
 *
 * Drawn as a rail rather than a stack of rows because these events are one
 * sequence — the same reasoning as the pipeline's stage rail. A list of
 * detached badges reads as unrelated facts; a line through them reads as the
 * order this video actually moved in.
 */
export function StatusEventsList({ events }: { events: StatusEvent[] }) {
  if (events.length === 0) {
    return <p className="text-muted-foreground text-sm">No events yet.</p>;
  }

  return (
    <ol className="space-y-3">
      {events.map((event, index) => (
        <li key={event.id} className="relative flex gap-3">
          {index < events.length - 1 && (
            <span
              aria-hidden="true"
              className="bg-foreground/10 absolute top-5 bottom-[-0.75rem] left-[3.5px] w-px"
            />
          )}
          <span
            aria-hidden="true"
            className="bg-muted-foreground/40 relative mt-2 size-2 shrink-0 rounded-full"
          />
          <div className="min-w-0 flex-1 space-y-1 text-sm">
            <div className="flex flex-wrap items-center gap-1.5">
              <VideoStatusBadge status={event.to} />
              <span className="text-muted-foreground text-xs">
                <RelativeTime date={event.createdAt} />
              </span>
            </div>
            {event.message && (
              <p className="text-muted-foreground text-xs">{event.message}</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
