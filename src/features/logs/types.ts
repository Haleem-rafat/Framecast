import type { LogLevel } from "@/generated/prisma/enums";

/**
 * One row as the Activity page renders it.
 *
 * `ActivityLog.metadata` is deliberately absent. It is a free-form `Json`
 * column that services fill with whatever context they had at the time, which
 * is not a vetted, operator-facing surface — the pipeline log stream refuses to
 * expose it for the same reason, and has a test pinning that behaviour
 * (pipeline.service.test.ts, "never surfaces ActivityLog.metadata"). This page
 * keeps that promise by never selecting the column.
 */
export interface ActivityLogEntry {
  id: string;
  level: LogLevel;
  action: string;
  message: string | null;
  entityType: string | null;
  entityId: string | null;
  createdAt: Date;
}

/** An action the operator has actually produced, with how many times. */
export interface ActivityActionOption {
  action: string;
  count: number;
}
