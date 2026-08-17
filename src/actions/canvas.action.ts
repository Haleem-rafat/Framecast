"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import { NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  moveCanvasNodeSchema,
  reparentAutomationSchema,
  setAutoPublishSchema,
  setAutomationViewSchema,
} from "@/schemas/canvas.schema";
import { requireSession } from "@/server/session";
import { canvasService } from "@/services/canvas.service";

/**
 * The automation canvas's write path.
 *
 * Same discipline as `release.action.ts` and every other action here: scope to
 * the signed-in user, parse the payload, funnel through `run()` so a driver
 * message can never reach the browser. A server action is a public endpoint
 * reachable by a hand-crafted POST with no UI in front of it, so nothing here
 * trusts what the canvas sent about who owns what.
 *
 * ## Why `setAutoPublishAction` writes Prisma directly
 *
 * The two writes it makes are one boolean and one enum on a row the operator
 * already owns, with no cross-field rule between them — there is no combination
 * of the pair that is invalid. Routing them through `SeriesService.update`
 * would mean sending the show's whole recipe (channel, project, script style,
 * format, cadence, variables) back from a canvas that is not showing any of it,
 * so a stale field on the client would silently overwrite an edit made on the
 * form. A scoped `updateMany` is both narrower and safer here.
 *
 * The ownership check is therefore in the `where`, and `count === 0` is the
 * refusal. That is the same shape `AutoPublishService.claimDue` uses and it
 * means a forged id simply matches nothing.
 */

const AUTOMATION_PATH = "/automation";

export async function moveCanvasNodeAction(input: unknown): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    const parsed = moveCanvasNodeSchema.parse(input);

    await canvasService.moveNode(session.user.id, parsed.nodeKey, parsed.x, parsed.y);

    // Deliberately no `revalidatePath`. This fires on every drag end, and the
    // position is already on screen — the client moved the node before the
    // request left. Revalidating would re-render the whole page to tell it
    // something it did to itself.
    return null;
  });
}

export async function setAutomationViewAction(
  input: unknown,
): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    const parsed = setAutomationViewSchema.parse(input);

    // Upsert rather than update: `UserSetting` is created lazily, so an
    // operator who has never opened settings has no row to update.
    await prisma.userSetting.upsert({
      where: { userId: session.user.id },
      create: { userId: session.user.id, automationView: parsed.view },
      update: { automationView: parsed.view },
    });

    revalidatePath(AUTOMATION_PATH);

    return null;
  });
}

export async function setAutoPublishAction(input: unknown): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    const parsed = setAutoPublishSchema.parse(input);
    const userId = session.user.id;

    const data = {
      autoPublish: parsed.enabled,
      publishVisibility: parsed.visibility,
    };

    const { count } =
      parsed.kind === "SERIES"
        ? await prisma.series.updateMany({
            where: { id: parsed.id, userId, deletedAt: null },
            data,
          })
        : await prisma.schedule.updateMany({
            where: {
              id: parsed.id,
              userId,
              deletedAt: null,
              // A series-owned schedule's copy of this pair is dead —
              // `resolveAutoPublish` reads the show's. Writing it would create
              // exactly the "setting the screen shows and the worker ignores"
              // state the whole feature was careful to avoid, so this refuses
              // rather than writing somewhere nothing reads.
              seriesId: null,
            },
            data,
          });

    if (count === 0) {
      throw new NotFoundError(
        parsed.kind === "SERIES"
          ? "That series no longer exists."
          : "That topic queue no longer exists, or it belongs to a series — " +
            "in which case publishing is set on the series itself.",
      );
    }

    revalidatePath(AUTOMATION_PATH);

    return null;
  });
}

/**
 * Moves an automation onto another channel.
 *
 * The one write in this file that changes where finished videos end up, so it
 * is the one that checks the most.
 *
 * The project must be the operator's, active, and **on the channel they named**
 * — that last check is the whole point. A series carries its own `channelId`
 * while `PublishService` uploads to the *project's*, and a pair that disagrees
 * is the state `AutomationEntry.channelWarning` exists to report and
 * `SeriesService.assertRecipe` exists to prevent. Writing both from one
 * verified pair is what stops a move creating it.
 *
 * A standalone schedule has no `channelId` of its own — it reads the channel
 * through its project, exactly as the renderer and the publisher do — so moving
 * one is only a change of project, and there is nothing that can disagree.
 *
 * Videos already made stay where they are. They are filed under the project
 * they were produced in, and moving them would rewrite history nobody asked to
 * rewrite; this governs what happens next.
 */
export async function reparentAutomationAction(
  input: unknown,
): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    const parsed = reparentAutomationSchema.parse(input);
    const userId = session.user.id;

    const project = await prisma.project.findFirst({
      where: {
        id: parsed.projectId,
        userId,
        deletedAt: null,
        status: "ACTIVE",
        // Named separately by the caller and checked here rather than derived,
        // so a payload whose two halves disagree is refused rather than
        // silently preferring one of them.
        channelId: parsed.channelId,
      },
      select: { id: true },
    });

    if (!project) {
      throw new NotFoundError(
        "That project is not available on the channel you moved this onto. " +
          "Pick one that belongs to it.",
      );
    }

    const { count } =
      parsed.kind === "SERIES"
        ? await prisma.series.updateMany({
            where: { id: parsed.id, userId, deletedAt: null },
            // Both, together. A series carrying one and not the other is
            // exactly the mismatch this action exists not to create.
            data: { channelId: parsed.channelId, projectId: parsed.projectId },
          })
        : await prisma.schedule.updateMany({
            where: { id: parsed.id, userId, deletedAt: null, seriesId: null },
            // No channelId: a standalone schedule reads its channel through the
            // project, so the project *is* the move.
            data: { projectId: parsed.projectId },
          });

    if (count === 0) {
      throw new NotFoundError(
        parsed.kind === "SERIES"
          ? "That series no longer exists."
          : "That topic queue no longer exists, or it belongs to a series — " +
            "move the series instead.",
      );
    }

    revalidatePath(AUTOMATION_PATH);

    return null;
  });
}
