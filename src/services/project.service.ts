import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { type MergeSuggestion, suggestMerges } from "@/lib/project-merge";
import type {
  CreateProjectInput,
  MergeProjectsInput,
} from "@/schemas/project.schema";

/**
 * Either the client or a transaction's, so `planMerge` can be the pre-check
 * the dialog reads *and* the check that actually holds inside `merge`. The
 * real `PrismaClient` is assignable to this — it is the same surface minus the
 * methods a transaction cannot offer.
 */
type PrismaClientOrTransaction = Prisma.TransactionClient;

/** One of the projects being dissolved, and what is filed under it. */
export interface MergeImpactSource {
  id: string;
  name: string;
  channelId: string | null;
  /** Null both when the project has no channel and when it has a deleted one. */
  channelTitle: string | null;
  status: "ACTIVE" | "ARCHIVED";
  videoCount: number;
  scheduleCount: number;
  seriesCount: number;
}

/** See `ProjectService.mergeImpact`. */
export interface MergeImpact {
  target: {
    id: string;
    name: string;
    channelId: string | null;
    channelTitle: string | null;
  };
  /** The requested sources, minus the target itself, minus duplicates. */
  sources: MergeImpactSource[];
  videoCount: number;
  scheduleCount: number;
  seriesCount: number;
  /** Videos the render worker is holding right now; a reason `merge` refuses. */
  activeRenderCount: number;
  /** Every reason the merge would be refused. Empty means it would go through. */
  blockers: string[];
}

export interface MergeResult {
  /** What the surviving project is called now — possibly renamed by the merge. */
  name: string;
  mergedProjectCount: number;
  videoCount: number;
  scheduleCount: number;
  seriesCount: number;
}

/**
 * How many attached series a refusal will name before it starts counting the
 * rest. Long enough that the usual case ("Pip's Little Wonders") reads as a
 * name rather than a number, short enough that a project with a dozen shows
 * does not produce a paragraph inside a toast.
 */
const NAMED_SERIES_LIMIT = 3;

/** "a", "a and b", "a, b and 4 others" — the list half of the refusals below. */
function nameSeries(series: { name: string }[]): string {
  const named = series.slice(0, NAMED_SERIES_LIMIT).map((row) => `"${row.name}"`);
  const rest = series.length - named.length;

  if (rest > 0) {
    return `${named.join(", ")} and ${rest} other${rest === 1 ? "" : "s"}`;
  }

  if (named.length <= 1) {
    return named.join("");
  }

  return `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
}

export class ProjectService {
  async list(userId: string) {
    return prisma.project.findMany({
      where: { userId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      // Scoped to `deletedAt: null` like every other video read — otherwise
      // a soft-deleted video (see `VideoService.remove`) would keep
      // inflating this project's count forever, even though it no longer
      // shows up anywhere the operator can see it.
      //
      // The series count joins it because the edit dialog has to be able to say
      // what moving this project's channel would do *before* the operator does
      // it — see `update` below, which refuses the move unless the request
      // acknowledges exactly this number.
      include: {
        _count: {
          select: {
            videos: { where: { deletedAt: null } },
            series: { where: { deletedAt: null } },
          },
        },
      },
    });
  }

  async create(userId: string, input: CreateProjectInput) {
    await this.assertOwnedChannel(userId, input.channelId ?? null);

    return prisma.project.create({
      data: {
        userId,
        name: input.name,
        description: input.description ?? null,
        channelId: input.channelId ?? null,
      },
    });
  }

  /**
   * Renames a project, and — the part that needs guarding — moves which channel
   * its videos publish to.
   *
   * `Project.channelId` is the authoritative answer to "where does this
   * publish": `PublishService` reads it (`video -> project -> channel`), so does
   * `brandService.resolve` for the look, voice and COPPA declaration, and so
   * does `ReleaseService` when it drips this video's shorts out later. A
   * `Series` stores a *copy* of it, and every series screen shows that copy.
   *
   * Which is why this method can no longer change the channel out from under an
   * attached series. It used to: one edit here silently redirected every episode
   * of every show filed under the project, while the series page went on
   * displaying the channel it used to publish to. That is not a cosmetic drift —
   * `videos.insert` cannot be undone, so the first anyone learns of it is a
   * children's bedtime story sitting on a personal finance channel.
   *
   * The two copies are therefore kept equal by construction from here on:
   *
   *   - No attached series, or no channel change: nothing to reconcile, and the
   *     write is exactly what it always was.
   *   - Attached series and a channel change: refused unless the caller sends
   *     `moveAttachedSeries`, which the edit dialog only offers once it has told
   *     the operator how many shows move and where to. With it, the project and
   *     every one of its series move together, in one transaction, so there is
   *     no instant at which the two disagree.
   *   - Attached series and a move to "no channel": refused outright. A series'
   *     channel is NOT NULL and carries its whole brand; there is no honest
   *     value to carry it to.
   */
  async update(userId: string, id: string, input: CreateProjectInput) {
    const nextChannelId = input.channelId ?? null;

    const project = await prisma.project.findFirst({
      where: { id, userId, deletedAt: null },
      select: {
        id: true,
        name: true,
        channelId: true,
        channel: { select: { title: true } },
        series: {
          where: { deletedAt: null },
          orderBy: { createdAt: "asc" },
          select: { id: true, name: true },
        },
      },
    });

    if (!project) {
      throw new NotFoundError("Project");
    }

    await this.assertOwnedChannel(userId, nextChannelId);

    const movesChannel = project.channelId !== nextChannelId;
    const attached = project.series;

    if (!movesChannel || attached.length === 0) {
      const { count } = await prisma.project.updateMany({
        where: { id, userId, deletedAt: null },
        data: {
          name: input.name,
          description: input.description ?? null,
          channelId: nextChannelId,
        },
      });

      if (count === 0) {
        throw new NotFoundError("Project");
      }

      return;
    }

    const from = project.channel?.title ?? "no channel";
    // "series" is its own plural, so the list needs no branch; the verbs do.
    const shows = `series ${nameSeries(attached)}`;
    const file = attached.length === 1 ? "files its" : "file their";

    if (nextChannelId === null) {
      throw new ConflictError(
        `"${project.name}" is where the ${shows} ${file} episodes, and a series has to ` +
          `have a channel — it takes its niche, voice, music, art style and ` +
          `made-for-kids declaration from one. Point the ${shows} at a different ` +
          `project first, or leave this project on ${from}.`,
      );
    }

    // Read for the message, not for the check. Naming the destination is the
    // difference between a refusal the operator can act on and one they have to
    // go and look up; ownership itself was already settled above.
    const destination = await prisma.channel.findFirst({
      where: { id: nextChannelId, userId, deletedAt: null },
      select: { title: true },
    });
    const to = destination?.title ?? "another channel";

    if (!input.moveAttachedSeries) {
      throw new ConflictError(
        `Moving "${project.name}" from ${from} to ${to} would move the ${shows} onto ${to} too — ` +
          `every future episode, and every episode already filed here that has not been ` +
          `published yet, would upload to ${to} instead. Publishing to YouTube cannot be ` +
          `undone. Confirm the move if that is what you want, or point the ${shows} at a ` +
          `different project first.`,
      );
    }

    // One transaction, because the whole point is that there is never a moment
    // at which `Project.channelId` and `Series.channelId` disagree — a reader
    // landing between two separate writes is exactly the state this method
    // exists to make unreachable.
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.project.updateMany({
        where: { id, userId, deletedAt: null },
        data: {
          name: input.name,
          description: input.description ?? null,
          channelId: nextChannelId,
        },
      });

      if (count === 0) {
        throw new NotFoundError("Project");
      }

      await tx.series.updateMany({
        where: { projectId: id, userId, deletedAt: null },
        data: { channelId: nextChannelId },
      });
    });
  }

  /**
   * A project may only point at a channel the operator actually owns.
   *
   * Never enforced before, because nothing downstream trusted the value on its
   * own — `channelService.resolveAccessToken` scopes by `userId`, so a foreign
   * id could not have produced an upload. It is enforced now because the
   * publish dialog offers a channel picker whose refusals are phrased in terms
   * of "the channel this video is filed under", and a project holding an id
   * that resolves to nothing turns every one of those sentences into a
   * half-truth. A null channel — "publishes nowhere in particular" — stays
   * perfectly legal.
   */
  private async assertOwnedChannel(
    userId: string,
    channelId: string | null,
  ): Promise<void> {
    if (channelId === null) {
      return;
    }

    const channel = await prisma.channel.findFirst({
      where: { id: channelId, userId, deletedAt: null },
      select: { id: true },
    });

    if (!channel) {
      throw new NotFoundError("Channel");
    }
  }

  async archive(userId: string, id: string) {
    const { count } = await prisma.project.updateMany({
      where: { id, userId, deletedAt: null },
      data: { status: "ARCHIVED", archivedAt: new Date() },
    });

    if (count === 0) {
      throw new NotFoundError("Project");
    }
  }

  /**
   * The way back from `archive`, and the reason that button can now honestly
   * call itself reversible. Restoring puts the project back in the new-video
   * picker (`/videos` filters that list to `ACTIVE`), which is the whole of
   * what archiving took away.
   *
   * Deliberately the mirror image of `archive` down to the `where` clause —
   * same `{ id, userId, deletedAt: null }` scoping, so a project belonging to
   * anyone else bounces off it with `NotFoundError` exactly as archiving does,
   * and same conditional `updateMany` rather than a read-then-write. In
   * particular it does *not* additionally require `status: "ARCHIVED"`:
   * restoring an already-active project is idempotent, and narrowing the
   * `where` would turn that harmless no-op into "Project was not found",
   * which is a lie about ownership.
   */
  async unarchive(userId: string, id: string) {
    const { count } = await prisma.project.updateMany({
      where: { id, userId, deletedAt: null },
      data: { status: "ACTIVE", archivedAt: null },
    });

    if (count === 0) {
      throw new NotFoundError("Project");
    }
  }

  /**
   * What `remove` would do to this project, read at the moment the operator is
   * being asked to confirm it — the numbers the delete confirmation states out
   * loud, and the pre-check for the one reason `remove` refuses.
   *
   * Read on demand rather than folded into `list`: `activeRenderCount` is the
   * refusal condition, and it is a function of `leaseExpiresAt > now`, so a
   * value baked into the page at render time is stale by the time anyone
   * clicks. It cannot close the race — `remove` re-checks inside its
   * transaction, and that check is the authority — but it is the difference
   * between telling the operator why the button will fail before they press it
   * and telling them afterwards. `videoCount` deliberately uses the same
   * `{ projectId, userId, deletedAt: null }` scope as `remove`'s cascading
   * `updateMany`, so the number in the confirmation is the number that goes.
   */
  async deletionImpact(
    userId: string,
    id: string,
  ): Promise<{
    videoCount: number;
    publishedCount: number;
    activeRenderCount: number;
  }> {
    const project = await prisma.project.findFirst({
      where: { id, userId, deletedAt: null },
      select: { id: true },
    });

    if (!project) {
      throw new NotFoundError("Project");
    }

    const scope = { projectId: id, userId, deletedAt: null } as const;
    const now = new Date();

    const [videoCount, publishedCount, activeRenderCount] = await Promise.all([
      prisma.video.count({ where: scope }),
      prisma.video.count({ where: { ...scope, status: "PUBLISHED" } }),
      prisma.video.count({
        where: {
          ...scope,
          status: { in: ["GENERATING", "RENDERING"] },
          leaseExpiresAt: { gt: now },
        },
      }),
    ]);

    return { videoCount, publishedCount, activeRenderCount };
  }

  /**
   * Soft delete, cascading to every one of this project's videos — see
   * `VideoService.remove` for what a video delete itself does (soft, files
   * left in place, YouTube untouched). Deliberately cascades rather than
   * leaving them behind: `Video.projectId` is required, not nullable, so an
   * orphaned video would still surface in every `videoService.list()` call
   * showing a project that no longer exists anywhere the operator can see
   * it. Archiving (`archive`, above) is the other, non-destructive way to
   * get a project out of the way — this is the one that actually removes it
   * and takes its videos with it.
   *
   * Refused, in full, if any of the project's videos is actively held by
   * the render worker (see `VideoService.remove`'s own doc comment on
   * leases) — an all-or-nothing check up front rather than deleting the
   * rest and silently skipping the busy ones, so the operator gets one
   * clear reason instead of a partially-deleted project to puzzle over.
   */
  async remove(userId: string, id: string): Promise<{ deletedVideoCount: number }> {
    const project = await prisma.project.findFirst({
      where: { id, userId, deletedAt: null },
      select: { id: true },
    });

    if (!project) {
      throw new NotFoundError("Project");
    }

    const now = new Date();

    return prisma.$transaction(async (tx) => {
      const activeCount = await tx.video.count({
        where: {
          projectId: id,
          deletedAt: null,
          status: { in: ["GENERATING", "RENDERING"] },
          leaseExpiresAt: { gt: now },
        },
      });

      if (activeCount > 0) {
        throw new ConflictError(
          `${activeCount} video${activeCount === 1 ? "" : "s"} in this project ` +
            `${activeCount === 1 ? "is" : "are"} actively being processed by the ` +
            `render worker. Cancel ${activeCount === 1 ? "it" : "them"} first, ` +
            "then delete the project.",
        );
      }

      const { count: deletedVideoCount } = await tx.video.updateMany({
        where: { projectId: id, userId, deletedAt: null },
        data: { deletedAt: now },
      });

      // Same conditional-update guard as `archive`, above: the `findFirst`
      // only produced a precise NotFoundError; this is what actually stops
      // a concurrent delete of the same project from applying twice.
      const { count } = await tx.project.updateMany({
        where: { id, userId, deletedAt: null },
        data: { deletedAt: now },
      });

      if (count === 0) {
        throw new ConflictError("This project changed unexpectedly.");
      }

      return { deletedVideoCount };
    });
  }

  /**
   * The obvious duplicates, so the operator does not have to go and find them.
   *
   * Offered because a merge nobody can reach is not a feature. A production
   * account here has 39 projects; the table pages at 25 and clears the
   * selection when you page, so "tick the sixteen `job-<uuid>` rows" is not
   * something a person can actually do. The grouping and the choice of
   * survivor are `src/lib/project-merge.ts`'s — see there for why a group is
   * split by channel and why a machine-generated name never wins the name.
   *
   * A suggestion is a starting point and nothing more: the dialog shows which
   * project survives and what it will be called, both are editable, and
   * `merge` re-checks every rule against the database whatever was suggested.
   */
  async mergeSuggestions(userId: string): Promise<MergeSuggestion[]> {
    const projects = await prisma.project.findMany({
      where: { userId, deletedAt: null },
      select: {
        id: true,
        name: true,
        channelId: true,
        status: true,
        createdAt: true,
        _count: { select: { videos: { where: { deletedAt: null } } } },
      },
    });

    return suggestMerges(
      projects.map((project) => ({
        id: project.id,
        name: project.name,
        channelId: project.channelId,
        status: project.status,
        createdAt: project.createdAt,
        videoCount: project._count.videos,
      })),
    );
  }

  /**
   * What `merge` would move, and every reason it would refuse — read at the
   * moment the operator is being asked to confirm.
   *
   * Same job and same reasoning as `deletionImpact`: the numbers stated in a
   * confirmation have to be read late to be worth anything, and one of them
   * (`activeRenderCount`) is a function of `leaseExpiresAt > now` and is stale
   * the instant it is computed. It cannot close the race — `merge` re-runs all
   * of this inside its transaction, and that run is the authority — but it is
   * the difference between explaining a refusal before the click and
   * delivering it as a toast afterwards.
   *
   * `blockers` is empty exactly when the merge would go through, so "no
   * message" and "safe to proceed" are deliberately the same answer.
   */
  async mergeImpact(userId: string, input: MergeProjectsInput): Promise<MergeImpact> {
    return this.planMerge(prisma, userId, input);
  }

  /**
   * Files everything under the source projects into the target and soft-deletes
   * the sources.
   *
   * ### What moves
   *
   * `Video`, `Schedule` and `Series` — the complete set of tables carrying a
   * `projectId` (checked against the schema, not against memory; nothing else
   * stores one, in a column or in JSON, and no unique constraint anywhere
   * involves it, so nothing can collide). Everything else — scripts, scenes,
   * assets, render jobs, shorts, publications, schedule topics and runs —
   * hangs off a `videoId` or a `scheduleId` and follows its parent without
   * being touched.
   *
   * Schedules and series matter as much as videos here and are the reason this
   * is not a loop over `video.updateMany`. `ProjectService.remove` cascades to
   * videos only, so a "merge" built as move-the-videos-then-delete would leave
   * a live schedule pointing at a soft-deleted project — still due, still
   * claimed by the worker, still filing videos into a project the operator can
   * no longer see. That is strictly worse than not merging at all.
   *
   * Soft-deleted children move too. They are invisible either way, and a
   * deleted video whose project is also deleted is a row nobody can ever
   * resolve back to anything; the counts reported to the operator still cover
   * only the live ones, because those are what they can see.
   *
   * ### Where the videos publish
   *
   * `Project.channelId` is the authoritative answer to "where does this
   * publish" — `PublishService.resolvePublishTarget` reads
   * `video -> project -> channel`, and so does `brandService.resolve` for the
   * look, the voice and the made-for-kids declaration. Moving a video between
   * projects therefore moves where it uploads, and an upload cannot be taken
   * back.
   *
   * So there is one rule, and it is a refusal rather than an acknowledgement:
   * **every source must already agree with the target about where its videos
   * publish, or have no answer at all.** A source on the target's channel is
   * fine. A source with no channel is fine — its videos could not publish
   * anywhere before and now they can, which is a gain and is said out loud in
   * the dialog. A source on a *different* channel is refused, and so is a
   * source with a channel merging into a target without one, which would
   * quietly disarm publishing for everything it holds.
   *
   * Refused rather than acknowledged, for three reasons. First, this is a
   * cleanup tool for accidental duplicates, and a genuine duplicate shares a
   * channel or has none — every measured one does. Second, the deliberate way
   * to move a project's channel already exists and is already guarded:
   * `ProjectService.update` names both channels, counts the shows that would
   * move and demands `moveAttachedSeries`. An operator who really means it can
   * point the source at the target's channel there, and then merge — two
   * explicit steps, the second of which is a same-channel merge. Third, this
   * operation is N-to-1 and is reached from a bulk selection: a single tickbox
   * covering twelve sources across three channels cannot honestly "name both
   * channels", because there are four. A refusal that names the offending
   * project and its channel is something an operator can act on; that tickbox
   * is not.
   *
   * The happy consequence is that `Series.channelId` never has to be rewritten.
   * A series requires its project's channel to equal its own
   * (`SeriesService.assertRecipe`), so a source holding a series has a channel,
   * so the target has the same one — the invariant that a series and its
   * project agree survives by construction rather than by a second write. It is
   * still checked explicitly below, on the series rows themselves, because an
   * invariant this expensive to break is worth two guards.
   *
   * ### One transaction
   *
   * Everything — the re-check, the three reassignments, the rename, the soft
   * delete and the record of what was destroyed — happens in one
   * `$transaction`. A half-merged pair is not a state any other part of this
   * app knows how to read.
   */
  async merge(userId: string, input: MergeProjectsInput): Promise<MergeResult> {
    return prisma.$transaction(async (tx) => {
      const plan = await this.planMerge(tx, userId, input);

      if (plan.blockers.length > 0) {
        throw new ConflictError(plan.blockers.join(" "));
      }

      const sourceIds = plan.sources.map((source) => source.id);
      const now = new Date();

      // No `deletedAt` filter on any of the three: the source rows are going
      // away, so every child has to come with them, visible or not.
      const scope = { projectId: { in: sourceIds }, userId } as const;

      await tx.video.updateMany({ where: scope, data: { projectId: plan.target.id } });
      await tx.schedule.updateMany({ where: scope, data: { projectId: plan.target.id } });
      await tx.series.updateMany({ where: scope, data: { projectId: plan.target.id } });

      // The rename rides along rather than being a second call, so the target
      // is never briefly a project full of somebody else's videos still
      // wearing a `job-<uuid>` name.
      const name = input.name?.trim() || plan.target.name;

      if (name !== plan.target.name) {
        const { count } = await tx.project.updateMany({
          where: { id: plan.target.id, userId, deletedAt: null },
          data: { name },
        });

        if (count === 0) {
          throw new ConflictError("This project changed unexpectedly.");
        }
      }

      const { count } = await tx.project.updateMany({
        where: { id: { in: sourceIds }, userId, deletedAt: null },
        data: { deletedAt: now },
      });

      // The same conditional-update guard `remove` uses, widened to N rows: if
      // anything else deleted one of these while we were reading, the count
      // disagrees and the whole merge rolls back rather than half-applying.
      if (count !== sourceIds.length) {
        throw new ConflictError(
          "One of these projects changed while the merge was being prepared. " +
            "Nothing was moved — reload the projects page and try again.",
        );
      }

      // Inside the transaction, not best-effort beside it. This row is the
      // only place the merged-away names survive in a form anyone reads: the
      // source rows keep their own `name` column, but they are soft-deleted
      // and nothing in the app lists them. Recording what was dissolved is
      // part of dissolving it, so if the record cannot be written the merge
      // does not happen either.
      await tx.activityLog.create({
        data: {
          userId,
          action: "project.merge",
          entityType: "Project",
          entityId: plan.target.id,
          message:
            `Merged ${plan.sources.map((source) => `"${source.name}"`).join(", ")} ` +
            `into "${name}" — ${plan.videoCount} video${plan.videoCount === 1 ? "" : "s"}, ` +
            `${plan.scheduleCount} schedule${plan.scheduleCount === 1 ? "" : "s"} and ` +
            `${plan.seriesCount} series moved.`,
          metadata: {
            targetId: plan.target.id,
            targetName: name,
            sources: plan.sources.map((source) => ({
              id: source.id,
              name: source.name,
            })),
            videoCount: plan.videoCount,
            scheduleCount: plan.scheduleCount,
            seriesCount: plan.seriesCount,
          },
        },
      });

      return {
        name,
        mergedProjectCount: sourceIds.length,
        videoCount: plan.videoCount,
        scheduleCount: plan.scheduleCount,
        seriesCount: plan.seriesCount,
      };
    });
  }

  /**
   * The whole of the merge's reading and every one of its rules, in one place,
   * run against whichever client it is handed.
   *
   * `mergeImpact` runs it on `prisma` and returns the refusals as data for the
   * dialog to show; `merge` runs it on its transaction client and throws them.
   * One implementation rather than two, because a pre-check that can disagree
   * with the check that actually holds is a pre-check that will eventually lie.
   */
  private async planMerge(
    client: PrismaClientOrTransaction,
    userId: string,
    input: MergeProjectsInput,
  ): Promise<MergeImpact> {
    const target = await client.project.findFirst({
      where: { id: input.targetId, userId, deletedAt: null },
      select: {
        id: true,
        name: true,
        status: true,
        channelId: true,
        channel: { select: { title: true } },
      },
    });

    if (!target) {
      throw new NotFoundError("Project");
    }

    // Selecting the target as one of the sources is not an error, it is what
    // "merge these four rows" looks like when the survivor is one of the four.
    // It is dropped, not refused.
    const sourceIds = [...new Set(input.sourceIds)].filter((id) => id !== target.id);

    const found = await client.project.findMany({
      where: { id: { in: sourceIds }, userId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        status: true,
        channelId: true,
        channel: { select: { title: true } },
        series: {
          where: { deletedAt: null },
          select: { id: true, name: true, channelId: true },
        },
        _count: {
          select: {
            videos: { where: { deletedAt: null } },
            schedules: { where: { deletedAt: null } },
            series: { where: { deletedAt: null } },
          },
        },
      },
    });

    if (found.length !== sourceIds.length) {
      throw new NotFoundError("Project");
    }

    const sources: MergeImpactSource[] = found.map((source) => ({
      id: source.id,
      name: source.name,
      channelId: source.channelId,
      channelTitle: source.channel?.title ?? null,
      status: source.status,
      videoCount: source._count.videos,
      scheduleCount: source._count.schedules,
      seriesCount: source._count.series,
    }));

    const activeRenderCount =
      sourceIds.length === 0
        ? 0
        : await client.video.count({
            where: {
              projectId: { in: sourceIds },
              userId,
              deletedAt: null,
              status: { in: ["GENERATING", "RENDERING"] },
              leaseExpiresAt: { gt: new Date() },
            },
          });

    const targetChannel = target.channel?.title ?? "no channel";
    const blockers: string[] = [];

    if (sourceIds.length === 0) {
      blockers.push(
        `Nothing would move: "${target.name}" is the project everything is being ` +
          "merged into. Select at least one other project.",
      );
    }

    if (target.status !== "ACTIVE") {
      blockers.push(
        `"${target.name}" is archived, so new videos cannot be created under it and ` +
          "any series moved into it could no longer be edited. Restore it first, then " +
          "merge into it.",
      );
    }

    // The refusal this whole operation is shaped around. Named per project, and
    // naming both channels, because "cross-channel merge refused" tells an
    // operator with twelve rows selected nothing about which one to unselect.
    for (const source of sources) {
      if (source.channelId === null || source.channelId === target.channelId) {
        continue;
      }

      blockers.push(
        `"${source.name}" publishes to ${source.channelTitle ?? "another channel"} and ` +
          `"${target.name}" publishes to ${targetChannel}, so merging would send every ` +
          `video moved out of "${source.name}" somewhere else — and an upload to the ` +
          `wrong channel cannot be taken back. Point "${source.name}" at ` +
          `${targetChannel} on its own Edit dialog first, which says how many shows ` +
          "that moves, and then merge.",
      );
    }

    // Second guard on the same invariant, checked on the series rows rather
    // than inferred from their projects. `SeriesService.assertRecipe` keeps
    // `Series.channelId` equal to its project's, `PublishService` refuses
    // outright when the two disagree, and this operation must not be the way
    // that disagreement gets created.
    for (const source of found) {
      for (const series of source.series) {
        if (series.channelId === target.channelId) continue;

        blockers.push(
          `The series "${series.name}" files its episodes in "${source.name}" and takes ` +
            `its niche, voice, art style and made-for-kids declaration from a channel ` +
            `that "${target.name}" does not publish to. Moving it would leave the show ` +
            "saying one thing on screen while its episodes uploaded somewhere else.",
        );
      }
    }

    if (activeRenderCount > 0) {
      blockers.push(
        `${activeRenderCount} video${activeRenderCount === 1 ? "" : "s"} in these ` +
          `projects ${activeRenderCount === 1 ? "is" : "are"} actively being processed ` +
          `by the render worker, and the render reads its look and voice through the ` +
          `project. Cancel ${activeRenderCount === 1 ? "it" : "them"} or wait for ` +
          `${activeRenderCount === 1 ? "it" : "them"} to finish, then merge.`,
      );
    }

    return {
      target: {
        id: target.id,
        name: target.name,
        channelId: target.channelId,
        channelTitle: target.channel?.title ?? null,
      },
      sources,
      videoCount: sources.reduce((total, source) => total + source.videoCount, 0),
      scheduleCount: sources.reduce((total, source) => total + source.scheduleCount, 0),
      seriesCount: sources.reduce((total, source) => total + source.seriesCount, 0),
      activeRenderCount,
      blockers,
    };
  }
}

export const projectService = new ProjectService();
