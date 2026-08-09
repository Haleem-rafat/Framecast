"use client";

import { useRouter, useSearchParams } from "next/navigation";

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

/** Reflects the filter in the URL so the list stays a plain server fetch, not client state. */
export function VideoStatusFilter({ current }: { current: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function onChange(value: string) {
    const params = new URLSearchParams(searchParams);

    if (value === ALL) {
      params.delete("status");
    } else {
      params.set("status", value);
    }

    router.push(`/videos${params.size > 0 ? `?${params.toString()}` : ""}`);
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
