import type { LogLevel, VideoStatus } from "@/generated/prisma/enums";

export interface DashboardStats {
  todayCount: number;
  scheduledCount: number;
  publishedCount: number;
  failedCount: number;
}

export interface RecentVideo {
  id: string;
  title: string;
  status: VideoStatus;
  projectName: string;
  updatedAt: Date;
}

export interface RecentActivity {
  id: string;
  action: string;
  message: string | null;
  level: LogLevel;
  createdAt: Date;
}

export interface DashboardOverview {
  stats: DashboardStats;
  recentVideos: RecentVideo[];
  recentActivity: RecentActivity[];
}

/**
 * The contract the dashboard page depends on, so it never needs to know which
 * implementation of `DashboardReader` is bound.
 */
export interface DashboardReader {
  getOverview(userId: string): Promise<DashboardOverview>;
}
