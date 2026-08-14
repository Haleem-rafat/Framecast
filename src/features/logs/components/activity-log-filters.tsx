"use client";

import { useRouter } from "next/navigation";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ActivityActionOption } from "@/features/logs/types";
import { LogLevel } from "@/generated/prisma/enums";

export const ALL = "ALL";

const LEVEL_LABELS: Record<string, string> = {
  [ALL]: "All levels",
  DEBUG: "Debug",
  INFO: "Info",
  WARN: "Warning",
  ERROR: "Error",
};

interface ActivityLogFiltersProps {
  action: string;
  level: string;
  /**
   * Built from the operator's own rows, not from a hardcoded list. Services
   * invent action names freely, so any fixed list would drift; deriving it
   * means the dropdown can only ever offer a filter that matches something.
   */
  actions: ActivityActionOption[];
}

/**
 * Mirrors both filters into the URL, so the list stays a plain server fetch
 * rather than client state — the same approach as the video status filter.
 * Changing either filter drops back to page 1: staying on page 7 of a
 * narrower result set would usually land on an empty page.
 */
export function ActivityLogFilters({
  action,
  level,
  actions,
}: ActivityLogFiltersProps) {
  const router = useRouter();

  function push(next: { action?: string; level?: string }) {
    const params = new URLSearchParams();
    const nextAction = next.action ?? action;
    const nextLevel = next.level ?? level;

    if (nextAction !== ALL) {
      params.set("action", nextAction);
    }
    if (nextLevel !== ALL) {
      params.set("level", nextLevel);
    }

    const query = params.toString();
    router.push(query ? `/logs?${query}` : "/logs");
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={action} onValueChange={(value) => push({ action: value })}>
        {/* 256px + 160px of fixed triggers is wider than a 375px screen's
         * content box, so on a phone each one takes the full width and they
         * stack — the flex-wrap above was only ever going to half-solve it. */}
        {/* A Select trigger's accessible name defaults to its own value, so
         * without this the control announces as "All actions" — the answer,
         * with the question missing. Two unlabelled filters side by side are
         * indistinguishable to anyone who cannot see which column they sit
         * over. An `aria-label` rather than a visible `<Label>` because the
         * row is deliberately label-less by design; the name still has to
         * exist somewhere. */}
        <SelectTrigger aria-label="Filter by action" className="w-full sm:w-64">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All actions</SelectItem>
          {actions.map((one) => (
            <SelectItem key={one.action} value={one.action}>
              {one.action} ({one.count})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={level} onValueChange={(value) => push({ level: value })}>
        <SelectTrigger aria-label="Filter by level" className="w-full sm:w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{LEVEL_LABELS[ALL]}</SelectItem>
          {Object.values(LogLevel).map((one) => (
            <SelectItem key={one} value={one}>
              {LEVEL_LABELS[one]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
