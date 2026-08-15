import "server-only";

import type {
  AdminActivityEntry,
  AdminChannelSummary,
  AdminCredentialSummary,
  AdminProjectSummary,
  AdminPublicationSummary,
  AdminSystemTotals,
  AdminUserDetail,
  AdminUserSummary,
  AdminVideoSummary,
} from "@/features/admin/types";
import { NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

/**
 * Cross-user reads, for the operator, and nothing else.
 *
 * ## Why this is a separate service and not a flag on the existing ones
 *
 * Every other service in this directory filters by `userId`, and the obvious
 * way to build an admin view is to thread `{ ...(isOperator ? {} : { userId }) }`
 * through those existing queries. That is the single change most likely to hand
 * one member another member's data, and it fails quietly: the condition sits
 * inside a `where` that already looks correct, twenty call sites keep passing
 * the flag along, and the day somebody defaults it wrong — or a new code path
 * forgets to pass it at all — `videoService.get` starts returning other
 * people's videos through a route nobody re-read. There would be no diff to
 * point at.
 *
 * So none of that happens here. This file shares no code path, no base class
 * and no helper with the scoped services; it imports `prisma` directly and
 * every method it exposes is named `admin*` at the call site. The existing
 * services were not touched, which means the property "every scoped query
 * filters by userId" is still checkable by reading them, and this file is the
 * only thing anyone has to audit to answer "what can an operator see".
 *
 * The gate is `requireOperator()` in src/server/session.ts, applied by the two
 * pages under /admin. Nothing here re-checks it, deliberately: a service that
 * half-enforces authorization invites callers to assume it fully does. What
 * this file does enforce is the audit — see `getUser`.
 *
 * ## Read-only
 *
 * There is no write method here beyond the audit row itself. Viewing another
 * person's data is one privilege and changing it is a different one; the owner
 * asked to see. The single cross-user mutation in the product is approve/reject
 * and it lives where it always did, in `accountService`.
 *
 * ## Secrets
 *
 * Nothing selected below is a credential, a token, a password hash or a
 * session. The full list, with the reasoning for each, is in the header of
 * src/features/admin/types.ts — including the non-obvious one: `ActivityLog.metadata`
 * carries password-reset URLs in this deployment and is never selected.
 */
export class AdminService {
  /**
   * Every account, newest registration first.
   *
   * Four queries rather than one `include`, because the counts are what make
   * this page useful and Prisma's relation `_count` cannot be filtered per
   * relation and aggregated across users in the same shape the list wants. At
   * the size this table will ever reach — tens of accounts — four indexed
   * scans is not a number worth optimising, and the alternative is a raw
   * query that would have to be re-audited every schema change.
   */
  async listUsers(operatorId: string): Promise<AdminUserSummary[]> {
    const [users, lastActivity] = await Promise.all([
      prisma.user.findMany({
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          email: true,
          approval: true,
          role: true,
          createdAt: true,
          approvedAt: true,
          // Soft-deleted rows are excluded so the counts mean "is working on"
          // rather than "has ever created", which is the question an operator
          // looking at a roster is asking.
          _count: {
            select: {
              projects: { where: { deletedAt: null } },
              videos: { where: { deletedAt: null } },
              channels: { where: { deletedAt: null } },
            },
          },
        },
      }),
      // One grouped scan for the whole table rather than a correlated subquery
      // per user. Served by `ActivityLog(userId, createdAt)`.
      prisma.activityLog.groupBy({
        by: ["userId"],
        _max: { createdAt: true },
      }),
    ]);

    const lastActiveByUser = new Map(
      lastActivity.flatMap((row) =>
        row.userId ? [[row.userId, row._max.createdAt] as const] : [],
      ),
    );

    await this.recordListView(operatorId, users.length);

    return users.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      approval: user.approval,
      role: user.role,
      createdAt: user.createdAt,
      approvedAt: user.approvedAt,
      projectCount: user._count.projects,
      videoCount: user._count.videos,
      channelCount: user._count.channels,
      lastActiveAt: lastActiveByUser.get(user.id) ?? null,
    }));
  }

  /**
   * One account in full, and the audit row that says the operator looked.
   *
   * `operatorId` is a required parameter rather than something the caller
   * passes to a separate `audit()` they might forget. The audit is not a side
   * effect of this method; it is half of what the method means. An operator
   * reading somebody else's projects, videos, channels and publications is
   * exactly the event a user is entitled to an answer about, and a version of
   * this function that could be called without leaving a trace would make that
   * answer unavailable — including to the owner, who is protected by the record
   * as much as anybody is.
   *
   * The write happens *before* the read returns and is awaited, so a request
   * that dies mid-render has still logged the access.
   */
  async getUser(operatorId: string, userId: string): Promise<AdminUserDetail> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        approval: true,
        role: true,
        createdAt: true,
        approvedAt: true,
        _count: {
          select: {
            projects: { where: { deletedAt: null } },
            videos: { where: { deletedAt: null } },
            channels: { where: { deletedAt: null } },
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundError("Account");
    }

    await this.recordUserView(operatorId, userId, user.email);

    // Every id, not the `VIDEO_LIMIT` page rendered below: this is what the
    // storage sum is scoped by, and a total that silently covered only the
    // hundred most recent videos would be worse than no total. Id-only off
    // `Video(userId, status, deletedAt)`, so it stays cheap.
    const videoIds = await prisma.video.findMany({
      where: { userId },
      select: { id: true },
    });

    const [
      projects,
      videos,
      channels,
      publications,
      credentials,
      recentActivity,
      storage,
      shortGroups,
      lastActivity,
    ] = await Promise.all([
      prisma.project.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          status: true,
          createdAt: true,
          deletedAt: true,
          _count: { select: { videos: { where: { deletedAt: null } } } },
        },
      }),
      prisma.video.findMany({
        where: { userId },
        orderBy: { updatedAt: "desc" },
        take: VIDEO_LIMIT,
        select: {
          id: true,
          title: true,
          status: true,
          failureReason: true,
          attempts: true,
          leaseExpiresAt: true,
          cancelRequestedAt: true,
          durationSeconds: true,
          createdAt: true,
          updatedAt: true,
          deletedAt: true,
          project: { select: { name: true } },
          // The newest attempt only. A stalled video explains itself in its
          // last render job far more often than in its history.
          renderJobs: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              status: true,
              progress: true,
              error: true,
              startedAt: true,
              finishedAt: true,
            },
          },
          shorts: { select: { status: true } },
        },
      }),
      prisma.channel.findMany({
        where: { userId },
        orderBy: { connectedAt: "desc" },
        // No accessToken, no refreshToken, no scopes. `tokenExpiresAt` is read
        // only to derive the boolean below and never leaves this method.
        select: {
          id: true,
          title: true,
          handle: true,
          youtubeChannelId: true,
          isActive: true,
          tokenExpiresAt: true,
          connectedAt: true,
          deletedAt: true,
          _count: { select: { publications: true } },
        },
      }),
      prisma.publication.findMany({
        where: { video: { userId } },
        orderBy: { createdAt: "desc" },
        take: PUBLICATION_LIMIT,
        select: {
          id: true,
          title: true,
          status: true,
          visibility: true,
          youtubeVideoId: true,
          scheduledFor: true,
          publishedAt: true,
          error: true,
          thumbnailApplied: true,
          thumbnailError: true,
          channel: { select: { title: true } },
        },
      }),
      prisma.providerCredential.findMany({
        where: { userId },
        orderBy: { provider: "asc" },
        // `encryptedKey` and `keyLastFour` are absent on purpose. That a key
        // exists and whether it last tested green is the whole of what an
        // operator needs to explain a failing render.
        select: {
          id: true,
          provider: true,
          label: true,
          isActive: true,
          lastTestedAt: true,
          lastTestOk: true,
          createdAt: true,
          deletedAt: true,
        },
      }),
      prisma.activityLog.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: ACTIVITY_LIMIT,
        // `metadata` is not selected, and that is a security boundary rather
        // than a payload-size decision — it holds password-reset URLs. See
        // the header of src/features/admin/types.ts.
        select: {
          id: true,
          action: true,
          level: true,
          message: true,
          createdAt: true,
        },
      }),
      /**
       * An `Asset` has no `userId`, and — this is the trap — its `sceneId` is
       * nullable and in practice always null: nothing in the pipeline attaches
       * one. Scoping through `scene.video.userId`, which is the join the
       * schema's relations invite, therefore matches zero rows and reports
       * every account as using no storage at all.
       *
       * The real convention is stated in `Asset`'s own schema comment: every
       * object lives under `videos/{videoId}/...` and `storagePath` prefix
       * matching is how an asset is scoped to its video. So that is what this
       * sums, one prefix per video the account owns.
       *
       * The `OR` is as long as the account has videos. At the tens-of-videos
       * scale this product operates at that is fine; it is the one query here
       * that would need rethinking for an account with thousands.
       */
      videoIds.length === 0
        ? Promise.resolve({ _sum: { sizeBytes: null } })
        : prisma.asset.aggregate({
            where: {
              deletedAt: null,
              OR: videoIds.map((video) => ({
                storagePath: { startsWith: `videos/${video.id}/` },
              })),
            },
            _sum: { sizeBytes: true },
          }),
      prisma.short.groupBy({
        by: ["status"],
        where: { video: { userId } },
        _count: { _all: true },
      }),
      prisma.activityLog.aggregate({
        where: { userId },
        _max: { createdAt: true },
      }),
    ]);

    const now = Date.now();

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        approval: user.approval,
        role: user.role,
        createdAt: user.createdAt,
        approvedAt: user.approvedAt,
        projectCount: user._count.projects,
        videoCount: user._count.videos,
        channelCount: user._count.channels,
        lastActiveAt: lastActivity._max.createdAt,
      },
      projects: projects.map(
        (project): AdminProjectSummary => ({
          id: project.id,
          name: project.name,
          status: project.status,
          videoCount: project._count.videos,
          createdAt: project.createdAt,
          deletedAt: project.deletedAt,
        }),
      ),
      videos: videos.map((video): AdminVideoSummary => {
        const [latestRender] = video.renderJobs;

        return {
          id: video.id,
          title: video.title,
          status: video.status,
          projectName: video.project.name,
          failureReason: video.failureReason,
          attempts: video.attempts,
          leaseExpiresAt: video.leaseExpiresAt,
          cancelRequestedAt: video.cancelRequestedAt,
          durationSeconds: video.durationSeconds,
          createdAt: video.createdAt,
          updatedAt: video.updatedAt,
          deletedAt: video.deletedAt,
          latestRender: latestRender
            ? {
                status: latestRender.status,
                progress: latestRender.progress,
                error: latestRender.error,
                startedAt: latestRender.startedAt,
                finishedAt: latestRender.finishedAt,
              }
            : null,
          shortCount: video.shorts.length,
          shortsUnfinished: video.shorts.filter(
            (short) => short.status !== "READY",
          ).length,
        };
      }),
      channels: channels.map(
        (channel): AdminChannelSummary => ({
          id: channel.id,
          title: channel.title,
          handle: channel.handle,
          youtubeChannelId: channel.youtubeChannelId,
          isActive: channel.isActive,
          tokenExpired: channel.tokenExpiresAt.getTime() <= now,
          connectedAt: channel.connectedAt,
          deletedAt: channel.deletedAt,
          publicationCount: channel._count.publications,
        }),
      ),
      publications: publications.map(
        (publication): AdminPublicationSummary => ({
          id: publication.id,
          title: publication.title,
          status: publication.status,
          visibility: publication.visibility,
          channelTitle: publication.channel.title,
          youtubeVideoId: publication.youtubeVideoId,
          scheduledFor: publication.scheduledFor,
          publishedAt: publication.publishedAt,
          error: publication.error,
          thumbnailApplied: publication.thumbnailApplied,
          thumbnailError: publication.thumbnailError,
        }),
      ),
      credentials: credentials.map(
        (credential): AdminCredentialSummary => ({
          id: credential.id,
          provider: credential.provider,
          label: credential.label,
          isActive: credential.isActive,
          lastTestedAt: credential.lastTestedAt,
          lastTestOk: credential.lastTestOk,
          createdAt: credential.createdAt,
          deletedAt: credential.deletedAt,
        }),
      ),
      recentActivity: recentActivity.map(
        (entry): AdminActivityEntry => ({
          id: entry.id,
          action: entry.action,
          level: entry.level,
          message: entry.message,
          createdAt: entry.createdAt,
        }),
      ),
      // BigInt cannot cross the RSC boundary into a client component, and
      // `Number` is exact to 9 petabytes — several orders of magnitude past
      // what a single VPS holds.
      storageBytes: Number(storage._sum.sizeBytes ?? 0),
      shorts: {
        total: shortGroups.reduce((sum, group) => sum + group._count._all, 0),
        byStatus: shortGroups.map((group) => ({
          status: group.status,
          count: group._count._all,
        })),
      },
    };
  }

  /**
   * The numbers the owner currently gets by asking for a psql session.
   *
   * No audit row: these are counts about the deployment, not about anybody.
   * There is no user whose data was read and so nobody to owe an answer to.
   */
  async systemTotals(): Promise<AdminSystemTotals> {
    const [
      userGroups,
      operatorCount,
      videoGroups,
      rendersInFlight,
      failedRenders,
      stalledVideos,
      failedShorts,
      channelCount,
      storage,
    ] = await Promise.all([
      prisma.user.groupBy({ by: ["approval"], _count: { _all: true } }),
      prisma.user.count({ where: { role: "OPERATOR" } }),
      prisma.video.groupBy({
        by: ["status"],
        where: { deletedAt: null },
        _count: { _all: true },
      }),
      prisma.renderJob.count({ where: { status: { in: ["QUEUED", "RUNNING"] } } }),
      prisma.renderJob.count({ where: { status: "FAILED" } }),
      // A lease in the past means the worker holding it died: the video is
      // claimable again but nothing has claimed it. This is the number that
      // explains "my video has said RENDERING for an hour".
      prisma.video.count({
        where: {
          deletedAt: null,
          status: { in: ["GENERATING", "RENDERING"] },
          leaseExpiresAt: { lt: new Date() },
        },
      }),
      prisma.short.count({ where: { status: "FAILED" } }),
      prisma.channel.count({ where: { deletedAt: null } }),
      // One sequential sum over `asset`. Cheap enough at this size to be worth
      // having, and the only figure here that is not an indexed count — if
      // this page ever gets slow, it is this line.
      prisma.asset.aggregate({
        where: { deletedAt: null },
        _sum: { sizeBytes: true },
      }),
    ]);

    const byApproval = new Map(
      userGroups.map((group) => [group.approval, group._count._all]),
    );

    return {
      userCount: userGroups.reduce((sum, group) => sum + group._count._all, 0),
      operatorCount,
      pendingCount: byApproval.get("PENDING") ?? 0,
      rejectedCount: byApproval.get("REJECTED") ?? 0,
      videosByStatus: videoGroups.map((group) => ({
        status: group.status,
        count: group._count._all,
      })),
      videoCount: videoGroups.reduce((sum, group) => sum + group._count._all, 0),
      rendersInFlight,
      failedRenders,
      stalledVideos,
      failedShorts,
      channelCount,
      storageBytes: Number(storage._sum.sizeBytes ?? 0),
    };
  }

  /**
   * "Who looked at whose data, and when."
   *
   * Attributed to the operator who looked, not to the person looked at, which
   * matches how `accountService.decide` records a decision — the log answers
   * "what did this operator do", and `entityId` carries whose data it was
   * about. That pairing is what makes the question answerable from either end:
   * `where: { userId: operator }` lists everything one operator read, and
   * `where: { entityType: "User", entityId: subject }` — an indexed lookup,
   * `ActivityLog(entityType, entityId)` — lists every operator who read one
   * person's data, which is the form the answer takes when a user asks.
   *
   * WARN rather than INFO. This is not routine traffic; it is one person
   * reading another's records, and it should stand out in a level filter
   * without anyone having to know the action name.
   *
   * An operator opening their own row writes nothing. There is no access to
   * account for — it is their data — and a log that recorded it would bury the
   * cross-user rows that matter under the operator's own browsing.
   */
  private async recordUserView(
    operatorId: string,
    userId: string,
    email: string,
  ): Promise<void> {
    if (operatorId === userId) return;

    await prisma.activityLog.create({
      data: {
        userId: operatorId,
        level: "WARN",
        action: "admin.user.view",
        entityType: "User",
        entityId: userId,
        message: `Viewed the account data of ${email}.`,
      },
    });
  }

  /**
   * The roster read, recorded too.
   *
   * The list is every account's name, email, join date and activity, so it is
   * a cross-user read even though it drills into nobody. It carries no
   * `entityId` — there is no single subject — which also keeps it out of the
   * per-subject query above, where a row saying "your name appeared in a list"
   * would drown the rows that say someone opened your record.
   */
  private async recordListView(
    operatorId: string,
    count: number,
  ): Promise<void> {
    await prisma.activityLog.create({
      data: {
        userId: operatorId,
        level: "INFO",
        action: "admin.users.list",
        message: `Listed all ${count} accounts in the admin view.`,
      },
    });
  }
}

/** Newest first, so the cap drops the least interesting rows. */
const VIDEO_LIMIT = 100;
const PUBLICATION_LIMIT = 50;
const ACTIVITY_LIMIT = 25;

export const adminService = new AdminService();
