import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

/**
 * Where a video actually got to, when the UI is not in front of you.
 *
 *   pnpm tsx --conditions=react-server scripts/video-status.ts            # every project
 *   pnpm tsx --conditions=react-server scripts/video-status.ts <projectId>
 *
 * ## Why this earns a place beside `doctor.ts`
 *
 * A pipeline run driven from a terminal (`make-insight-video.ts`, or the worker
 * picking a job up) reports progress to whichever stdout started it, and that
 * stdout is routinely gone by the time somebody asks what happened. The row is
 * the only account that survives, and this prints it: the status, the script it
 * ended up with, whether narration was synthesised, and what the render did.
 *
 * The opening line is printed on purpose. It is the one part of a script that
 * decides whether the video is watched at all (`short-hook.ts`), so it is worth
 * seeing without opening the studio.
 *
 * Read-only.
 */

/** Enough to see a run and the two before it, few enough to read at a glance. */
const LIMIT = 5;

async function main(): Promise<void> {
  const { prisma } = await import("@/lib/prisma");
  const [projectId] = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));

  const videos = await prisma.video.findMany({
    where: {
      deletedAt: null,
      ...(projectId ? { projectId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: LIMIT,
    select: {
      id: true,
      title: true,
      status: true,
      format: true,
      createdAt: true,
      project: { select: { name: true } },
      script: { select: { activeVersion: { select: { wordCount: true, content: true } } } },
      voiceOver: { select: { durationSeconds: true } },
      renderJobs: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { status: true, progress: true, outputUrl: true, error: true },
      },
    },
  });

  if (videos.length === 0) {
    console.log(projectId ? `no videos in project ${projectId}` : "no videos");
  }

  for (const video of videos) {
    const render = video.renderJobs[0];
    const version = video.script?.activeVersion;

    console.log(
      `\n${video.createdAt.toISOString().slice(0, 16)}  ${video.status.padEnd(10)} ` +
        `${video.format.padEnd(9)} ${video.project.name}`,
    );
    console.log(`  ${video.title}`);
    console.log(
      `  script ${version?.wordCount ?? "—"} words  ·  narration ${video.voiceOver?.durationSeconds ?? "—"}s`,
    );
    console.log(
      `  render ${render ? `${render.status} ${render.progress}% ${render.outputUrl ?? ""}` : "none"}` +
        `${render?.error ? `\n    ${render.error.slice(0, 140)}` : ""}`,
    );

    if (version?.content) {
      // The same sentence `checkHook` judges — first terminator that is not
      // inside a number, so a price in the opening line is not cut in half.
      const [opening] = version.content.replace(/\s+/g, " ").split(/(?<!\d)[.?!](?=\s|$)/);
      console.log(`  opens  "${opening.trim()}."`);
    }
  }

  console.log();
  await prisma.$disconnect();
}

void main();
