import "server-only";

import { endOfDay, startOfDay } from "date-fns";

import { isPreviewMode } from "@/config/env";
import type {
  DashboardOverview,
  DashboardReader,
  DashboardStats,
  RecentActivity,
  RecentVideo,
} from "@/features/dashboard/types";
import { prisma } from "@/lib/prisma";
import { PreviewDashboardService } from "@/services/dashboard.preview.service";

const RECENT_VIDEO_LIMIT = 6;
const RECENT_ACTIVITY_LIMIT = 8;

/**
 * Read model for the dashboard overview. Every query is scoped by `userId` and
 * excludes soft-deleted rows, so this is already multi-user safe.
 */
export class DashboardService implements DashboardReader {
  async getOverview(userId: string): Promise<DashboardOverview> {
    const [stats, recentVideos, recentActivity] = await Promise.all([
      this.getStats(userId),
      this.getRecentVideos(userId),
      this.getRecentActivity(userId),
    ]);

    return { stats, recentVideos, recentActivity };
  }

  private async getStats(userId: string): Promise<DashboardStats> {
    const now = new Date();
    const notDeleted = { userId, deletedAt: null };

    const [todayCount, scheduledCount, publishedCount, failedCount] =
      await Promise.all([
        prisma.video.count({
          where: {
            ...notDeleted,
            createdAt: { gte: startOfDay(now), lte: endOfDay(now) },
          },
        }),
        prisma.publication.count({
          where: {
            video: notDeleted,
            status: "SCHEDULED",
            scheduledFor: { gte: now },
          },
        }),
        prisma.video.count({ where: { ...notDeleted, status: "PUBLISHED" } }),
        prisma.video.count({ where: { ...notDeleted, status: "FAILED" } }),
      ]);

    return { todayCount, scheduledCount, publishedCount, failedCount };
  }

  private async getRecentVideos(userId: string): Promise<RecentVideo[]> {
    const videos = await prisma.video.findMany({
      where: { userId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      take: RECENT_VIDEO_LIMIT,
      select: {
        id: true,
        title: true,
        status: true,
        updatedAt: true,
        project: { select: { name: true } },
      },
    });

    return videos.map((video) => ({
      id: video.id,
      title: video.title,
      status: video.status,
      projectName: video.project.name,
      updatedAt: video.updatedAt,
    }));
  }

  private async getRecentActivity(userId: string): Promise<RecentActivity[]> {
    return prisma.activityLog.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: RECENT_ACTIVITY_LIMIT,
      select: {
        id: true,
        action: true,
        message: true,
        level: true,
        createdAt: true,
      },
    });
  }
}

/**
 * Composition point. Consumers depend on `DashboardReader`, never on which
 * implementation is bound — so removing preview mode is a one-line change here.
 */
export const dashboardService: DashboardReader = isPreviewMode
  ? new PreviewDashboardService()
  : new DashboardService();
