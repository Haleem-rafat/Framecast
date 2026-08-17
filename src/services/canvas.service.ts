import "server-only";

import { prisma } from "@/lib/prisma";
import {
  automationListService,
  type AutomationEntry,
} from "@/services/automation-list.service";

/**
 * The automation canvas's read model.
 *
 * ## Why it composes rather than queries
 *
 * `automation-list.service.ts` already produces exactly the per-automation
 * facts this needs — status, paused reason, cadence prose, backlog, produced,
 * published, the channel, the mismatch warning — across all three kinds, and
 * sorted by health. Re-querying here would mean a second definition of every
 * one of those, free to drift from the first. The rule that file states about
 * itself applies to this one too: it is a read-only projection for one screen
 * and it owns no rules.
 *
 * So this file does the two things the list cannot. It groups by channel,
 * because a canvas is branches where a table is rows. And it joins the saved
 * positions.
 *
 * ## Why the grouping is not a query
 *
 * `automationListService.list` returns entries already ordered by how much
 * attention they need. Grouping them in a `Map` preserves that order — first
 * insertion wins — so the first branch on the canvas belongs to the channel
 * with the most wrong with it. A `groupBy` in Postgres would have thrown that
 * ordering away and needed it recomputed here from `describeHealth`, which is
 * the second definition this file exists to avoid.
 */

export interface CanvasBranch {
  /**
   * Null for the one honest case: a standalone schedule whose project has no
   * channel.
   *
   * Those collect in a final unrooted branch rather than being hidden, because
   * an automation whose videos have nowhere to publish is precisely the thing
   * an operator needs to see. It is drawn last regardless of health — see
   * `read` — since one orphaned schedule should not push three working channels
   * down the canvas.
   */
  channel: { id: string; title: string } | null;
  automations: AutomationEntry[];
  /**
   * The projects filed under this channel, which is what a move onto it would
   * have to pick from.
   *
   * Carried on the branch rather than fetched when a drag starts, because the
   * answer decides whether the move is possible at all: a channel with no
   * project cannot receive an automation, and `SeriesService.assertRecipe`
   * refuses a series whose project belongs to a different channel. Knowing that
   * up front is what lets the drop explain itself instead of failing after.
   *
   * Empty for the unrooted branch, which has no channel to file anything under.
   */
  projects: { id: string; name: string }[];
}

export interface CanvasModel {
  branches: CanvasBranch[];
  /**
   * Saved node positions, keyed by node key. An absent key means "never moved",
   * and `autoPlace` decides where it goes — no read fails because a position is
   * missing.
   */
  positions: Record<string, { x: number; y: number }>;
}

export class CanvasService {
  /**
   * Everything one canvas needs, in two round trips.
   *
   * The two are independent, so they run together rather than in sequence: the
   * positions do not depend on which automations came back, and a position for
   * a node that no longer exists is simply never looked up.
   */
  async read(userId: string): Promise<CanvasModel> {
    const [entries, nodes, projects] = await Promise.all([
      automationListService.list(userId),
      prisma.canvasNode.findMany({
        where: { userId },
        select: { nodeKey: true, x: true, y: true },
      }),
      // Every usable project at once rather than per branch. An operator has a
      // handful, and the alternative is a query per channel for a list the drag
      // needs before it can say whether a drop is possible.
      prisma.project.findMany({
        where: { userId, deletedAt: null, status: "ACTIVE", channelId: { not: null } },
        orderBy: { name: "asc" },
        select: { id: true, name: true, channelId: true },
      }),
    ]);

    const projectsOf = new Map<string, { id: string; name: string }[]>();

    for (const project of projects) {
      // Non-null by the `where` above; the column is nullable and the compiler
      // is right to insist.
      if (!project.channelId) continue;

      const existing = projectsOf.get(project.channelId);
      const entry = { id: project.id, name: project.name };

      if (existing) existing.push(entry);
      else projectsOf.set(project.channelId, [entry]);
    }

    const byChannel = new Map<string, CanvasBranch>();

    for (const entry of entries) {
      // The empty string is the unrooted bucket. Safe as a key because a
      // channel id is a uuid and can never be empty.
      const key = entry.channel?.id ?? "";
      const existing = byChannel.get(key);

      if (existing) {
        existing.automations.push(entry);
        continue;
      }

      byChannel.set(key, {
        channel: entry.channel,
        automations: [entry],
        projects: entry.channel ? (projectsOf.get(entry.channel.id) ?? []) : [],
      });
    }

    const branches = [...byChannel.values()];

    // The unrooted branch last, whatever the health sort said about the
    // automations in it. It is a footnote rather than a headline.
    branches.sort((a, b) => Number(a.channel === null) - Number(b.channel === null));

    return {
      branches,
      positions: Object.fromEntries(
        nodes.map((node) => [node.nodeKey, { x: node.x, y: node.y }]),
      ),
    };
  }

  /**
   * Remembers where a node was dropped.
   *
   * An upsert rather than an update, because the first time any given node
   * moves there is nothing to update — and `[userId, nodeKey]` being unique is
   * what lets that be one statement instead of a read and a branch.
   *
   * No validation of the key. It is opaque by design (see `CanvasNode.nodeKey`),
   * and a row naming a node that no longer exists is read by nobody: `read`
   * looks positions *up* by the keys it is already drawing. Validating the shape
   * here would mean a second copy of the key vocabulary, free to disagree with
   * the canvas that builds it.
   */
  async moveNode(userId: string, nodeKey: string, x: number, y: number): Promise<void> {
    await prisma.canvasNode.upsert({
      where: { userId_nodeKey: { userId, nodeKey } },
      create: { userId, nodeKey, x, y },
      update: { x, y },
    });
  }
}

export const canvasService = new CanvasService();
