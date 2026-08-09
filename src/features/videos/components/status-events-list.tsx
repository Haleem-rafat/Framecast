import { Activity } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

export function StatusEventsList({ events }: { events: StatusEvent[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Activity className="size-4" />
          Recent activity
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {events.length === 0 ? (
          <p className="text-muted-foreground text-sm">No events yet.</p>
        ) : (
          events.map((event) => (
            <div key={event.id} className="space-y-1 text-sm">
              <div className="flex items-center gap-1.5">
                <VideoStatusBadge status={event.to} />
                <span className="text-muted-foreground text-xs">
                  <RelativeTime date={event.createdAt} />
                </span>
              </div>
              {event.message && (
                <p className="text-muted-foreground text-xs">{event.message}</p>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
