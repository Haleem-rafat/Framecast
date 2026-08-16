import "server-only";

import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import type { CreateProjectInput } from "@/schemas/project.schema";

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
}

export const projectService = new ProjectService();
