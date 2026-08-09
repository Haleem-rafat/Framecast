import "server-only";

import { subDays, subHours, subMinutes } from "date-fns";

import type {
  DashboardOverview,
  DashboardReader,
} from "@/features/dashboard/types";

/**
 * TEMPORARY — design-preview only. Serves fixture data so the dashboard renders
 * with no database. Delete this file (and PREVIEW_MODE) once Postgres is up.
 *
 * Timestamps are relative to now so the "x minutes ago" rendering stays honest.
 */
export class PreviewDashboardService implements DashboardReader {
  async getOverview(_userId: string): Promise<DashboardOverview> {
    const now = new Date();

    return {
      stats: {
        todayCount: 3,
        scheduledCount: 5,
        publishedCount: 42,
        failedCount: 1,
      },
      recentVideos: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          title: "Why the Antikythera Mechanism Still Baffles Engineers",
          status: "RENDERING",
          projectName: "Ancient Tech",
          updatedAt: subMinutes(now, 4),
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          title: "5 Rust Patterns That Replaced My Python Scripts",
          status: "READY",
          projectName: "Dev Shorts",
          updatedAt: subMinutes(now, 38),
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          title: "The Voyager Probes Are Still Sending Data",
          status: "PUBLISHED",
          projectName: "Deep Space",
          updatedAt: subHours(now, 3),
        },
        {
          id: "44444444-4444-4444-8444-444444444444",
          title: "How Bread Mold Ended Up Saving Millions of Lives",
          status: "GENERATING",
          projectName: "Ancient Tech",
          updatedAt: subHours(now, 5),
        },
        {
          id: "55555555-5555-4555-8555-555555555555",
          title: "Every Compression Algorithm, Ranked",
          status: "FAILED",
          projectName: "Dev Shorts",
          updatedAt: subHours(now, 9),
        },
        {
          id: "66666666-6666-4666-8666-666666666666",
          title: "The Cassini Grand Finale, Explained",
          status: "DRAFT",
          projectName: "Deep Space",
          updatedAt: subDays(now, 1),
        },
      ],
      recentActivity: [
        {
          id: "a1111111-1111-4111-8111-111111111111",
          action: "render.started",
          message: "Compositing 14 scenes with narration and subtitles",
          level: "INFO",
          createdAt: subMinutes(now, 4),
        },
        {
          id: "a2222222-2222-4222-8222-222222222222",
          action: "voice.generated",
          message: "ElevenLabs · 8m 12s of narration",
          level: "INFO",
          createdAt: subMinutes(now, 21),
        },
        {
          id: "a3333333-3333-4333-8333-333333333333",
          action: "render.failed",
          message: "ffmpeg exited with code 1: no such filter 'zoompan'",
          level: "ERROR",
          createdAt: subMinutes(now, 47),
        },
        {
          id: "a4444444-4444-4444-8444-444444444444",
          action: "provider.rate_limited",
          message: "Runway returned 429 — retrying in 60s",
          level: "WARN",
          createdAt: subHours(now, 1),
        },
        {
          id: "a5555555-5555-4555-8555-555555555555",
          action: "youtube.published",
          message: "The Voyager Probes Are Still Sending Data → unlisted",
          level: "INFO",
          createdAt: subHours(now, 3),
        },
        {
          id: "a6666666-6666-4666-8666-666666666666",
          action: "script.generated",
          message: "OpenAI · 1,284 words · version 3",
          level: "INFO",
          createdAt: subHours(now, 4),
        },
        {
          id: "a7777777-7777-4777-8777-777777777777",
          action: "thumbnail.generated",
          message: "4 variants produced",
          level: "INFO",
          createdAt: subHours(now, 6),
        },
        {
          id: "a8888888-8888-4888-8888-888888888888",
          action: "channel.connected",
          message: "Connected @deep-space-daily",
          level: "INFO",
          createdAt: subDays(now, 2),
        },
      ],
    };
  }
}
