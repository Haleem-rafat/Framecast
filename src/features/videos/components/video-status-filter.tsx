"use client";

import { useRouter } from "next/navigation";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { VideoStatus } from "@/generated/prisma/enums";

const ALL = "ALL";

const STATUS_OPTIONS = [ALL, ...Object.values(VideoStatus)];

const STATUS_LABELS: Record<string, string> = {
  [ALL]: "All statuses",
  DRAFT: "Draft",
  QUEUED: "Queued",
  GENERATING: "Generating",
  RENDERING: "Rendering",
  READY: "Ready",
  PUBLISHED: "Published",
  FAILED: "Failed",
};

/**
 * Reflects the filter in the URL so the list stays a plain server fetch, not
 * client state. `status` is the only query param this route reads, so this
 * writes it directly rather than pulling in `useSearchParams()` — which would
 * force a Suspense boundary around this component for no benefit here.
 */
export function VideoStatusFilter({ current }: { current: string }) {
  const router = useRouter();

  function onChange(value: string) {
    router.push(value === ALL ? "/videos" : `/videos?status=${value}`);
  }

  return (
    <Select value={current} onValueChange={onChange}>
      <SelectTrigger className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {STATUS_OPTIONS.map((status) => (
          <SelectItem key={status} value={status}>
            {STATUS_LABELS[status]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
