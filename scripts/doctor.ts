import { config } from "dotenv";

// .env.local first, exactly as scripts/render.ts and prisma.config.ts do.
config({ path: ".env.local" });
config({ path: ".env" });

// Everything below is imported dynamically inside main(), never at module top
// level — `@/config/env` reads process.env at import time and would run before
// the dotenv calls above. Same reason scripts/render.ts does it.

/**
 * One command that answers "why has this studio stopped producing videos".
 *
 *   pnpm doctor
 *   pnpm doctor --probe     # also spends ~$0.0002 proving the gateway answers
 *
 * ## Why this exists
 *
 * On 25 August 2026 the AI Gateway hit its spend limit. For the next two days
 * every scheduled run across five schedules failed on an HTTP 402, and the only
 * thing anybody could see was "The model provider failed to generate a script."
 * Finding the real cause took a database query, a `docker logs`, and a call to
 * an endpoint nothing in this repo had ever called. That is too many steps for
 * a question this common, so they are one step now.
 *
 * `gateway-failure.ts` fixes the *reporting* of that specific failure. This
 * fixes the *looking* — it is deliberately broader than one incident, and every
 * section below is a thing that has actually gone wrong here at least once.
 *
 * ## Read-only
 *
 * Nothing here writes, claims, pauses or spends — except `--probe`, which makes
 * one five-token model call because "is the gateway answering at all" cannot be
 * established any other way. Safe to run against production.
 */

/** Balance below which the gateway is worth shouting about: roughly two videos
 *  at the rates this deployment actually pays (a script attempt runs to about
 *  $0.20, a set of twelve stills to about $0.07). */
const LOW_BALANCE_USD = 2;

/** How far back the spend and failure summaries look. */
const WINDOW_HOURS = 24;

function heading(title: string): void {
  console.log(`\n[1m${title}[0m`);
}

/** The gateway's own view of the money, which is the one that decides whether
 *  a call succeeds — not anything this database has added up. */
async function reportCredits(apiKey: string): Promise<void> {
  heading("AI Gateway");

  try {
    const response = await fetch("https://ai-gateway.vercel.sh/v1/credits", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      console.log(`  credits    HTTP ${response.status} — ${(await response.text()).slice(0, 120)}`);
      return;
    }

    const { balance, total_used: used } = (await response.json()) as {
      balance: string;
      total_used: string;
    };
    const left = Number(balance);

    console.log(`  balance    $${left.toFixed(2)}   (used $${Number(used).toFixed(2)})`);

    if (left <= 0) {
      console.log("  [31m→ EXHAUSTED. Every script call fails with a 402 until this is topped up.[0m");
    } else if (left < LOW_BALANCE_USD) {
      console.log(`  [33m→ under $${LOW_BALANCE_USD}: about two more videos before it stops.[0m`);
    }
  } catch (error) {
    console.log(`  credits    unreachable — ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** One five-token call. Distinguishes "the gateway is refusing us" from "the
 *  gateway is slow" from "our key is wrong", which the credits call alone
 *  cannot. */
async function probe(apiKey: string): Promise<void> {
  const { env } = await import("@/config/env");
  const { createGateway, generateText } = await import("ai");
  const { describeGatewayFailure } = await import("@/lib/gateway-failure");

  heading("Gateway probe");
  const started = Date.now();

  try {
    await generateText({
      model: createGateway({ apiKey }).languageModel(env.AI_SCRIPT_MODEL),
      prompt: "Reply with the single word: ready",
      abortSignal: AbortSignal.timeout(60_000),
    });
    console.log(`  ${env.AI_SCRIPT_MODEL}  ok  ${Date.now() - started}ms`);
  } catch (error) {
    const failure = describeGatewayFailure(error);
    console.log(`  ${env.AI_SCRIPT_MODEL}  FAILED  ${Date.now() - started}ms`);
    console.log(`  ${failure.message ?? (error instanceof Error ? error.message : String(error))}`);
  }
}

async function main(): Promise<void> {
  const { env } = await import("@/config/env");
  const { prisma } = await import("@/lib/prisma");
  const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000);

  const apiKey = env.AI_GATEWAY_API_KEY;

  if (apiKey) {
    await reportCredits(apiKey);

    if (process.argv.includes("--probe")) {
      await probe(apiKey);
    }
  } else {
    heading("AI Gateway");
    console.log("  no AI_GATEWAY_API_KEY set");
  }

  // ---- what the schedules actually did -----------------------------------
  heading(`Scheduled runs (last ${WINDOW_HOURS}h)`);

  const runs = await prisma.scheduleRun.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { scheduledFor: "desc" },
    take: 15,
    select: { scheduledFor: true, outcome: true, reason: true },
  });

  if (runs.length === 0) {
    console.log("  none");
  }

  for (const run of runs) {
    const colour = run.outcome === "FAILED" ? "[31m" : run.outcome === "SUCCEEDED" ? "[32m" : "";
    console.log(
      `  ${run.scheduledFor.toISOString().slice(0, 16)}  ${colour}${run.outcome.padEnd(9)}[0m ` +
        (run.reason ?? "").slice(0, 100),
    );
  }

  // A paused schedule makes nothing and says nothing unless somebody looks, so
  // it is listed even when it is older than the window above.
  const paused = await prisma.schedule.findMany({
    where: { status: "PAUSED", deletedAt: null },
    select: { name: true, pausedReason: true, pausedByOperator: true },
  });

  if (paused.length > 0) {
    heading("Paused schedules");
    for (const schedule of paused) {
      console.log(
        `  ${schedule.name}${schedule.pausedByOperator ? " (by you)" : ""}\n    ` +
          `${(schedule.pausedReason ?? "no reason recorded").slice(0, 160)}`,
      );
    }
  }

  // ---- what it cost, and what failed -------------------------------------
  heading(`Provider spend (last ${WINDOW_HOURS}h)`);

  const spend = await prisma.providerUsage.groupBy({
    by: ["provider", "operation"],
    where: { createdAt: { gte: since } },
    _sum: { costUsd: true },
    _count: { _all: true },
  });

  let total = 0;

  for (const row of spend) {
    const cost = Number(row._sum.costUsd ?? 0);
    total += cost;
    console.log(
      `  ${row.provider.padEnd(11)} ${String(row.operation).padEnd(18)} ` +
        `${String(row._count._all).padStart(3)} calls  $${cost.toFixed(4)}`,
    );
  }

  console.log(`  ${"".padEnd(11)} ${"total".padEnd(18)}          $${total.toFixed(4)}`);

  const failures = await prisma.providerUsage.count({
    where: { createdAt: { gte: since }, succeeded: false },
  });

  if (failures > 0) {
    console.log(`  [33m${failures} call(s) failed in this window[0m`);
  }

  // ---- channels whose figures have stopped arriving ----------------------
  heading("Analytics collection");

  const collections = await prisma.channelCollection.findMany({
    where: { lastError: { not: null } },
    select: {
      lastError: true,
      consecutiveFailures: true,
      channel: { select: { title: true } },
    },
  });

  if (collections.length === 0) {
    console.log("  every connected channel is collecting");
  }

  for (const collection of collections) {
    console.log(
      `  [31m${collection.channel.title}[0m (${collection.consecutiveFailures} failure(s))\n` +
        `    ${(collection.lastError ?? "").slice(0, 140)}`,
    );
  }

  console.log();
  await prisma.$disconnect();
}

void main();
