# Automation Canvas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat automation table with a draggable canvas — one branch per channel, showing each automation's state, what it has made and how much of that reached YouTube.

**Architecture:** A React Flow canvas with freely draggable, persisted node positions. The *edges*, unlike the positions, are foreign keys, so `isValidConnection` greys out every invalid drop target mid-drag rather than refusing after it. Reads extend `automation-list.service.ts` rather than replacing it; a new `canvas.service.ts` groups its entries by channel and joins saved positions.

**Tech Stack:** TypeScript, Next.js 15 App Router, Prisma 7 / Postgres, `@xyflow/react` 12.11.3, Vitest, shadcn/Radix, Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-08-17-automation-canvas-design.md` — Plan 2. Plan 1 (auto-publish) landed in commits `5f82f40`…`115a35e` and this plan depends on its `Series.autoPublish` / `Schedule.autoPublish` columns.

## Global Constraints

- **Tests need a real Postgres the Mac does not have.** Run `pnpm lint` and `pnpm typecheck` locally; run the suite on the VPS (command in `2026-08-17-auto-publish.md`). Never claim tests pass without that output.
- **Every service test creates its own throwaway user** via `createTestUser` / `deleteTestUser`.
- **`AUTOMATION_KINDS` in `src/features/automation/kinds.tsx` is the registry.** Node cards read their icon, label, `backlogNoun`, `producedNoun` and `Controls` from it. Nothing in the canvas may branch on `entry.kind` directly — adding a fourth kind must stay a one-entry change.
- **The table is not deleted.** `/automation` gains a Canvas ⇄ Table toggle, canvas default.
- **Positions are the operator's; the viewport is the session's.** Zoom and pan are not persisted.
- **Comment style:** explain *why*, and say plainly what was deliberately not done.
- **New dependency:** `@xyflow/react` only. No layout engine — positions are saved, so nothing computes them but `auto-place.ts` for a node that has none.

---

## File Structure

**Create:**
- `prisma/migrations/20260817140000_add_automation_canvas/migration.sql`
- `src/services/canvas.service.ts` — the grouped read model and `moveNode`
- `src/services/canvas.service.test.ts`
- `src/actions/canvas.action.ts` — move, reparent, toggle auto-publish, set view
- `src/schemas/canvas.schema.ts`
- `src/features/automation/canvas/valid-connections.ts` (+ `.test.ts`) — pure rules
- `src/features/automation/canvas/auto-place.ts` (+ `.test.ts`) — pure placement
- `src/features/automation/canvas/automation-canvas.tsx` — the React Flow shell
- `src/features/automation/canvas/nodes/channel-node.tsx`
- `src/features/automation/canvas/nodes/automation-node.tsx`
- `src/features/automation/canvas/nodes/publish-node.tsx`
- `src/features/automation/canvas/node-inspector.tsx`
- `src/features/automation/canvas/use-node-positions.ts`
- `src/features/automation/components/view-toggle.tsx`

**Modify:**
- `prisma/schema.prisma` — `CanvasNode`, `AutomationView`, `UserSetting.automationView`
- `src/services/automation-list.service.ts` — `published` and `autoPublish` on `AutomationEntry`
- `src/app/(dashboard)/automation/page.tsx` — the toggle and the canvas
- `src/app/globals.css` — React Flow theme variables

---

### Task 1: Schema and migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260817140000_add_automation_canvas/migration.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `CanvasNode` model, `AutomationView` enum (`CANVAS` | `TABLE`), `UserSetting.automationView`.

- [ ] **Step 1: Add the enum and the model to `prisma/schema.prisma`**

```prisma
/// Which way `/automation` draws itself for this operator.
///
/// A column rather than `localStorage` for the third reason `onboardingSeen`
/// gives for the same choice: the dashboard layout already reads this row for
/// theme and accent, so the chosen view renders on the server and there is no
/// flash of the wrong one on every navigation.
enum AutomationView {
  CANVAS
  TABLE
}

/// Where one node sits on this operator's automation canvas.
///
/// Positions carry no information — the structure is the data — so this table
/// buys arrangement rather than meaning. That is a real thing to want, and it
/// is the reason this exists at all; it is also why nothing here is load
/// bearing. A row that goes missing costs a node its remembered place and
/// `autoPlace` puts it somewhere sensible.
model CanvasNode {
  id String @id @default(uuid()) @db.Uuid

  userId String @db.Uuid
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  /// "channel:<id>", "series:<id>", "schedule:<id>", "release:<id>",
  /// "publish:series:<id>". A string rather than a foreign key, and the same
  /// choice `AutomationEntry.rowId` and `UserSetting.onboardingSeen` already
  /// make: ids are unique only within a table, five kinds of thing share this
  /// canvas, and a sixth should be a content change rather than a migration.
  ///
  /// The cost is that a deleted series leaves a row pointing at nothing. That
  /// is harmless — the canvas reads positions by looking *up* the keys it is
  /// already drawing, never by listing this table — and they are swept lazily
  /// rather than by a cascade this key cannot express.
  nodeKey String

  x Float
  y Float

  updatedAt DateTime @updatedAt

  @@unique([userId, nodeKey])
  @@map("canvas_node")
}
```

In `model UserSetting`, after `onboardingSeen`:

```prisma
  /// Canvas or table on /automation. CANVAS because the complaint that led to
  /// it was that the table reads like a CRM; an operator who prefers the table
  /// flips it once and it sticks.
  automationView        AutomationView    @default(CANVAS)
```

In `model User`, beside the other back-relations:

```prisma
  canvasNodes         CanvasNode[]
```

- [ ] **Step 2: Write the migration**

Create `prisma/migrations/20260817140000_add_automation_canvas/migration.sql`:

```sql
-- The automation canvas: node positions, and which view an operator prefers.
--
-- /automation was one flat table with three kinds of automation sorted by
-- health. That answers "which automation is unhealthy" and not "what is my kids
-- channel doing", and the answer to the second is a shape rather than a row.
--
-- Positions are stored because the operator asked to arrange their own canvas.
-- They carry no information — the structure is already in the foreign keys — so
-- nothing downstream depends on a row existing: a node with no position is
-- placed by `autoPlace` instead.
CREATE TYPE "AutomationView" AS ENUM ('CANVAS', 'TABLE');

ALTER TABLE "user_setting"
  ADD COLUMN "automationView" "AutomationView" NOT NULL DEFAULT 'CANVAS';

CREATE TABLE "canvas_node" (
  "id"        UUID NOT NULL,
  "userId"    UUID NOT NULL,
  -- "series:<uuid>", "channel:<uuid>", "publish:series:<uuid>", ... A string
  -- rather than a foreign key: five kinds of thing share this canvas and their
  -- ids are unique only within their own tables.
  "nodeKey"   TEXT NOT NULL,
  "x"         DOUBLE PRECISION NOT NULL,
  "y"         DOUBLE PRECISION NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "canvas_node_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "canvas_node_userId_nodeKey_key" ON "canvas_node"("userId", "nodeKey");

ALTER TABLE "canvas_node"
  ADD CONSTRAINT "canvas_node_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 3: Regenerate and verify**

Run: `pnpm db:generate && pnpm typecheck`
Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
git add prisma/ src/generated
git commit -m "feat: remember where an operator put each node, and which view they want"
```

---

### Task 2: `published` and `autoPublish` on the read model

**Files:**
- Modify: `src/services/automation-list.service.ts`

**Interfaces:**
- Consumes: Plan 1's `Series.autoPublish` / `Schedule.autoPublish` columns.
- Produces: on `AutomationEntry` —
  - `published: number`
  - `autoPublish: { enabled: boolean; visibility: PublishVisibility } | null`

- [ ] **Step 1: Add the fields to the interface**

```ts
  /**
   * How many of `produced` actually reached YouTube.
   *
   * The number the operator asked for. "Made 34, published 30" is a different
   * and far more useful fact than either half alone — it is the difference
   * between a show that is working and a show that is filling a folder.
   */
  published: number;
  /**
   * Whether this automation publishes its own output, or null for a kind that
   * cannot.
   *
   * Present-and-disabled is a different state from absent, and the canvas has
   * to draw both: a series with the switch off gets a publish node it can turn
   * on, and a shorts drip gets none because publishing *is* what it does.
   */
  autoPublish: { enabled: boolean; visibility: PublishVisibility } | null;
```

- [ ] **Step 2: Fill it in `loadSeries`**

Add to the `select`: `autoPublish: true`, `publishVisibility: true`, and a second `_count` entry:

```ts
      _count: {
        select: {
          videos: { where: { deletedAt: null } },
          // "Reached YouTube", not "was attempted". A Publication row exists
          // from the moment an upload starts, so the status filter is what
          // makes this the honest half of "made 34, published 30".
          publishedVideos: true,
        },
      },
```

Prisma cannot alias a count on the same relation twice, so `published` is a separate grouped query rather than a `_count`. Add above the `return`:

```ts
  // One grouped count for every series at once, rather than a query per row —
  // the same shape `loadReleaseCadences` already uses for its bank.
  const publishedBySeries = await prisma.video.groupBy({
    by: ["seriesId"],
    where: {
      userId,
      deletedAt: null,
      seriesId: { in: rows.map((row) => row.id) },
      publication: { is: { status: "PUBLISHED" } },
    },
    _count: { _all: true },
  });
  const publishedOf = new Map(
    publishedBySeries.map((group) => [group.seriesId, group._count._all]),
  );
```

and in the mapped object:

```ts
        published: publishedOf.get(row.id) ?? 0,
        autoPublish: {
          enabled: row.autoPublish,
          visibility: row.publishVisibility,
        },
```

- [ ] **Step 3: Fill it in `loadTopicQueues`**

A standalone schedule tags no videos, so its published count comes through its runs. Add to the `_count` select:

```ts
          // Runs whose video actually reached YouTube. The `runs` count beside
          // it is "what did this make"; this is "what went out".
          publishedRuns: true,
```

Again as a grouped query rather than a second `_count` alias — add above the `return`:

```ts
  const publishedByschedule = await prisma.scheduleRun.groupBy({
    by: ["scheduleId"],
    where: {
      scheduleId: { in: rows.map((row) => row.id) },
      video: { is: { publication: { is: { status: "PUBLISHED" } } } },
    },
    _count: { _all: true },
  });
  const publishedOf = new Map(
    publishedByschedule.map((group) => [group.scheduleId, group._count._all]),
  );
```

and in the mapped object:

```ts
    published: publishedOf.get(row.id) ?? 0,
    autoPublish: { enabled: row.autoPublish, visibility: row.publishVisibility },
```

Add `autoPublish: true, publishVisibility: true` to that loader's `select`.

- [ ] **Step 4: Fill it in `loadReleaseCadences`**

```ts
    // Identical to `produced` by construction: that count already filters on
    // `youtubeVideoId: { not: null }`, which is the same question. Stated
    // rather than left implied, because a reader comparing the three loaders
    // will otherwise wonder which is wrong.
    published: row._count.runs,
    // A cadence has no switch: publishing is the entirety of what it does, and
    // offering to turn it off would be offering to turn the cadence off twice.
    autoPublish: null,
```

- [ ] **Step 5: Verify**

Run: `pnpm lint && pnpm typecheck`. Expected: clean. Then the suite on the VPS.

- [ ] **Step 6: Commit**

```bash
git add src/services/automation-list.service.ts
git commit -m "feat: say how many of an automation's videos actually went out"
```

---

### Task 3: The pure rules — `valid-connections.ts` and `auto-place.ts`

**Files:**
- Create: `src/features/automation/canvas/valid-connections.ts` + `.test.ts`
- Create: `src/features/automation/canvas/auto-place.ts` + `.test.ts`

**Interfaces:**
- Consumes: `AutomationKind` from `@/services/automation-list.service`.
- Produces:
  - `type CanvasNodeKind = "CHANNEL" | "AUTOMATION" | "PUBLISH"`
  - `interface CanvasNodeRef { kind: CanvasNodeKind; id: string; automationKind?: AutomationKind; hasReleaseCadence?: boolean }`
  - `function connectionOutcome(source, target): ConnectionOutcome`
  - `type ConnectionOutcome = { valid: true; action: "REPARENT" | "ENABLE_PUBLISH" | "ATTACH_CADENCE" } | { valid: false; reason: string }`
  - `function autoPlace(taken: {x,y}[], anchor: {x,y}): {x,y}`

- [ ] **Step 1: Write the failing tests for `valid-connections`**

```ts
import { describe, expect, it } from "vitest";

import { connectionOutcome } from "@/features/automation/canvas/valid-connections";

const channel = (id = "c1", hasReleaseCadence = false) =>
  ({ kind: "CHANNEL" as const, id, hasReleaseCadence });
const series = (id = "s1") =>
  ({ kind: "AUTOMATION" as const, id, automationKind: "SERIES" as const });
const queue = (id = "q1") =>
  ({ kind: "AUTOMATION" as const, id, automationKind: "TOPIC_QUEUE" as const });
const drip = (id = "r1") =>
  ({ kind: "AUTOMATION" as const, id, automationKind: "RELEASE_CADENCE" as const });
const publish = (id = "s1") => ({ kind: "PUBLISH" as const, id });

describe("connectionOutcome", () => {
  it("lets a channel adopt a series", () => {
    expect(connectionOutcome(channel(), series())).toEqual({
      valid: true,
      action: "REPARENT",
    });
  });

  it("lets a channel adopt a topic queue", () => {
    expect(connectionOutcome(channel(), queue())).toEqual({
      valid: true,
      action: "REPARENT",
    });
  });

  it("lets an automation be wired to its publish node", () => {
    expect(connectionOutcome(series(), publish())).toEqual({
      valid: true,
      action: "ENABLE_PUBLISH",
    });
  });

  it("attaches a shorts drip to a channel that has none", () => {
    expect(connectionOutcome(channel("c1", false), drip())).toEqual({
      valid: true,
      action: "ATTACH_CADENCE",
    });
  });

  it("refuses a second shorts drip on one channel", () => {
    // `ReleaseCadence.channelId` is @unique. The refusal has to be visible
    // while dragging, not after dropping.
    const outcome = connectionOutcome(channel("c1", true), drip());
    expect(outcome.valid).toBe(false);
  });

  it("refuses a channel dropped on a channel", () => {
    expect(connectionOutcome(channel("c1"), channel("c2")).valid).toBe(false);
  });

  it("refuses an automation dropped on an automation", () => {
    expect(connectionOutcome(series("s1"), queue("q1")).valid).toBe(false);
  });

  it("refuses a publish node as a source", () => {
    // A publish node is a leaf. It has no output.
    expect(connectionOutcome(publish(), series()).valid).toBe(false);
  });

  it("refuses wiring an automation to another automation's publish node", () => {
    // The publish node's id IS its automation's id. Anything else would turn on
    // auto-publish for a show the operator was not pointing at.
    expect(connectionOutcome(series("s1"), publish("s2")).valid).toBe(false);
  });

  it("refuses a shorts drip a publish node", () => {
    // Publishing is the whole of what a drip does; there is no switch.
    expect(connectionOutcome(drip(), publish("r1")).valid).toBe(false);
  });

  it("gives every refusal a sentence", () => {
    const outcome = connectionOutcome(channel("c1", true), drip());
    if (outcome.valid) throw new Error("expected a refusal");
    expect(outcome.reason.length).toBeGreaterThan(20);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Expected: `Cannot find module '.../valid-connections'`.

- [ ] **Step 3: Implement `valid-connections.ts`**

```ts
import type { AutomationKind } from "@/services/automation-list.service";

/**
 * Which drops the canvas accepts, as a pure function.
 *
 * ## Why this exists at all
 *
 * The operator asked for a canvas they can arrange, and positions are theirs.
 * The *edges* are not: every one of them is a foreign key. `ReleaseCadence`
 * is `@unique` per channel, a series must agree with its project's channel
 * (`SeriesService.assertRecipe` enforces exactly that and stays the only place
 * that does), and a publish node belongs to precisely one automation.
 *
 * In n8n any output reaches any input. Here most drops would have to be
 * refused, and a canvas that refuses most drops after you make them teaches the
 * operator not to trust it. So this runs during the drag — React Flow's
 * `isValidConnection` — and every invalid target greys out before a drop
 * happens. The affordance and the rule agree at all times.
 *
 * Pure and separately tested because it is the whole of the canvas's
 * correctness. Everything else is drawing.
 */

export type CanvasNodeKind = "CHANNEL" | "AUTOMATION" | "PUBLISH";

export interface CanvasNodeRef {
  kind: CanvasNodeKind;
  /** The underlying row's id. For a publish node this is its *automation's*
   *  id — the pairing is what makes "wire this show to that show's publish
   *  node" expressible and therefore refusable. */
  id: string;
  automationKind?: AutomationKind;
  /** Only meaningful on a CHANNEL. Whether it already has a shorts drip. */
  hasReleaseCadence?: boolean;
}

export type ConnectionOutcome =
  | { valid: true; action: "REPARENT" | "ENABLE_PUBLISH" | "ATTACH_CADENCE" }
  | { valid: false; reason: string };

const REFUSE = (reason: string): ConnectionOutcome => ({ valid: false, reason });

export function connectionOutcome(
  source: CanvasNodeRef,
  target: CanvasNodeRef,
): ConnectionOutcome {
  // A publish node is a leaf. Nothing flows out of it, so it can never be a
  // source — checked first so the later branches never have to consider it.
  if (source.kind === "PUBLISH") {
    return REFUSE(
      "A publish step is the end of a branch. Drag from the automation instead.",
    );
  }

  if (source.kind === "CHANNEL") {
    if (target.kind !== "AUTOMATION") {
      return REFUSE(
        target.kind === "CHANNEL"
          ? "Channels do not connect to each other — each one is its own branch."
          : "Drop this on an automation, not on a publish step.",
      );
    }

    if (target.automationKind === "RELEASE_CADENCE") {
      return source.hasReleaseCadence
        ? REFUSE(
            "This channel already has a shorts drip, and a channel can only have " +
              "one. Edit the existing drip instead of attaching a second.",
          )
        : { valid: true, action: "ATTACH_CADENCE" };
    }

    return { valid: true, action: "REPARENT" };
  }

  // source.kind === "AUTOMATION"
  if (target.kind !== "PUBLISH") {
    return REFUSE(
      "Automations do not feed each other. Drop this on its publish step, or " +
        "drag from a channel to move it.",
    );
  }

  if (source.automationKind === "RELEASE_CADENCE") {
    return REFUSE(
      "A shorts drip already publishes — that is the whole of what it does. " +
        "There is nothing to switch on.",
    );
  }

  // The publish node's id is its automation's id. A mismatch means the operator
  // dragged across branches, which would turn on auto-publish for a show they
  // were not pointing at.
  if (source.id !== target.id) {
    return REFUSE("That publish step belongs to a different automation.");
  }

  return { valid: true, action: "ENABLE_PUBLISH" };
}
```

- [ ] **Step 4: Run and watch them pass**

- [ ] **Step 5: Write the failing tests for `auto-place`**

```ts
import { describe, expect, it } from "vitest";

import { autoPlace } from "@/features/automation/canvas/auto-place";

describe("autoPlace", () => {
  it("puts the first node at the anchor", () => {
    expect(autoPlace([], { x: 100, y: 100 })).toEqual({ x: 100, y: 100 });
  });

  it("steps down when the anchor is taken", () => {
    const placed = autoPlace([{ x: 100, y: 100 }], { x: 100, y: 100 });
    expect(placed).not.toEqual({ x: 100, y: 100 });
    expect(placed.x).toBe(100);
    expect(placed.y).toBeGreaterThan(100);
  });

  it("keeps stepping past a run of taken slots", () => {
    const taken = [
      { x: 100, y: 100 },
      { x: 100, y: 220 },
      { x: 100, y: 340 },
    ];
    const placed = autoPlace(taken, { x: 100, y: 100 });
    expect(taken).not.toContainEqual(placed);
  });

  it("is deterministic — the same tree twice places identically", () => {
    const taken = [{ x: 0, y: 0 }];
    expect(autoPlace(taken, { x: 0, y: 0 })).toEqual(autoPlace(taken, { x: 0, y: 0 }));
  });

  it("treats near-misses as taken", () => {
    // Two nodes 8px apart overlap on screen. "Free" has to mean visually free,
    // not merely unequal.
    const placed = autoPlace([{ x: 100, y: 104 }], { x: 100, y: 100 });
    expect(placed.y).toBeGreaterThan(104);
  });
});
```

- [ ] **Step 6: Implement `auto-place.ts`**

```ts
/**
 * Where a node with no saved position goes.
 *
 * The whole of the first-load experience, and of "you just made a new series",
 * so it is a pure function with its own tests rather than something eyeballed
 * once. Positions are otherwise the operator's — nothing else in the canvas
 * computes one.
 *
 * Deliberately dumb: step straight down from the anchor until a slot is
 * visually free. No packing, no force layout, no collision resolution beyond
 * one axis. Anything cleverer would move nodes the operator had already placed,
 * which is the one thing a canvas with saved positions must never do.
 */

/** Vertical gap between stacked nodes. Comfortably more than a node card's
 *  height so two never touch. */
const STEP = 120;

/** How close counts as occupied. Two cards 8px apart overlap on screen, so
 *  "free" has to mean visually free rather than merely not-equal. */
const CLEARANCE = 60;

export interface Point {
  x: number;
  y: number;
}

export function autoPlace(taken: readonly Point[], anchor: Point): Point {
  // Bounded rather than `while (true)`: a canvas cannot have more nodes than
  // this and an unbounded loop in a render path is worse than a slight overlap
  // in a case that cannot happen.
  for (let step = 0; step < 500; step += 1) {
    const candidate = { x: anchor.x, y: anchor.y + step * STEP };

    const clashes = taken.some(
      (point) =>
        Math.abs(point.x - candidate.x) < CLEARANCE &&
        Math.abs(point.y - candidate.y) < CLEARANCE,
    );

    if (!clashes) return candidate;
  }

  return anchor;
}
```

- [ ] **Step 7: Run, lint, typecheck, commit**

```bash
git add src/features/automation/canvas/
git commit -m "feat: decide which canvas drops are real edits, and where a new node lands"
```

---

### Task 4: `canvas.service.ts` — the grouped read model

**Files:**
- Create: `src/services/canvas.service.ts` + `.test.ts`

**Interfaces:**
- Consumes: `automationListService.list`, `AutomationEntry` from Task 2; `prisma.canvasNode`.
- Produces:
  - `interface CanvasBranch { channel: { id: string; title: string } | null; automations: AutomationEntry[] }`
  - `interface CanvasModel { branches: CanvasBranch[]; positions: Record<string, {x:number;y:number}> }`
  - `canvasService.read(userId): Promise<CanvasModel>`
  - `canvasService.moveNode(userId, nodeKey, x, y): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { canvasService } from "@/services/canvas.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

let userId: string;

beforeEach(async () => {
  userId = await createTestUser("canvas");
});

afterEach(async () => {
  await deleteTestUser(userId);
});

describe("read", () => {
  it("returns no branches for an account with no automations", async () => {
    const model = await canvasService.read(userId);
    expect(model.branches).toEqual([]);
    expect(model.positions).toEqual({});
  });

  it("carries a saved position back under its node key", async () => {
    await canvasService.moveNode(userId, "series:abc", 120, 340);

    const model = await canvasService.read(userId);

    expect(model.positions["series:abc"]).toEqual({ x: 120, y: 340 });
  });
});

describe("moveNode", () => {
  it("overwrites a position rather than accumulating rows", async () => {
    await canvasService.moveNode(userId, "series:abc", 10, 10);
    await canvasService.moveNode(userId, "series:abc", 99, 99);

    const rows = await prisma.canvasNode.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].x).toBe(99);
  });

  it("keeps one operator's canvas out of another's", async () => {
    const otherId = await createTestUser("canvas-other");
    try {
      await canvasService.moveNode(userId, "series:abc", 10, 10);
      const other = await canvasService.read(otherId);
      expect(other.positions).toEqual({});
    } finally {
      await deleteTestUser(otherId);
    }
  });
});
```

- [ ] **Step 2: Implement**

```ts
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
 * published, channel, the mismatch warning — across all three kinds, with the
 * health sort the canvas wants for its node ordering anyway. Re-querying would
 * be a second definition of every one of those, drifting.
 *
 * So this file does two things the list cannot: it groups by channel, because a
 * canvas is branches and a table is rows; and it joins the saved positions.
 * It owns no rules, exactly as `automation-list.service.ts` says of itself.
 */

export interface CanvasBranch {
  /** Null for the one honest case: a standalone schedule whose project has no
   *  channel. Those collect in a final unrooted branch rather than being hidden
   *  — an automation nobody can publish is precisely what wants looking at. */
  channel: { id: string; title: string } | null;
  automations: AutomationEntry[];
}

export interface CanvasModel {
  branches: CanvasBranch[];
  /** Keyed by node key. Absent means "never moved" and `autoPlace` decides. */
  positions: Record<string, { x: number; y: number }>;
}

export class CanvasService {
  async read(userId: string): Promise<CanvasModel> {
    const [entries, nodes] = await Promise.all([
      automationListService.list(userId),
      prisma.canvasNode.findMany({
        where: { userId },
        select: { nodeKey: true, x: true, y: true },
      }),
    ]);

    // Insertion order is the health order `automationListService` sorted into,
    // so the first branch is the channel with the most to worry about.
    const byChannel = new Map<string, CanvasBranch>();

    for (const entry of entries) {
      const key = entry.channel?.id ?? "";
      const existing = byChannel.get(key);

      if (existing) {
        existing.automations.push(entry);
        continue;
      }

      byChannel.set(key, { channel: entry.channel, automations: [entry] });
    }

    const branches = [...byChannel.values()];

    // The unrooted branch last, whatever the health sort said. It is a footnote
    // rather than a headline: one or two orphaned schedules should not push
    // three working channels down the canvas.
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
   * An upsert on `[userId, nodeKey]` rather than an update, because the first
   * time any node moves there is nothing to update. No validation of the key:
   * it is opaque by design (see `CanvasNode.nodeKey`), and a row naming a node
   * that no longer exists is read by nobody — `read` looks positions *up* by
   * the keys it is already drawing.
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
```

- [ ] **Step 3: Run, lint, typecheck, commit**

---

### Task 5: Server actions

**Files:**
- Create: `src/schemas/canvas.schema.ts`, `src/actions/canvas.action.ts`

**Interfaces:**
- Consumes: `canvasService.moveNode`; `seriesService.update`; `scheduleService.update`.
- Produces: `moveCanvasNodeAction`, `setAutomationViewAction`, `setAutoPublishAction`.

- [ ] **Step 1: Follow the existing action shape**

Read `src/actions/release.action.ts` first — every action in this codebase returns a discriminated `{ ok: true, ... } | { ok: false, error }` and calls `requireUser()`. Match it exactly; do not invent a second convention.

- [ ] **Step 2: Write `canvas.schema.ts`**

```ts
import { z } from "zod";

/** A node position as the canvas reports it. Bounded because these are written
 *  from the client on every drag end, and an unbounded float would let a
 *  malformed payload store NaN or Infinity into a column the canvas then reads
 *  back and cannot lay out. */
const coordinate = z.number().finite().min(-100_000).max(100_000);

export const moveCanvasNodeSchema = z.object({
  /** Opaque by design — see `CanvasNode.nodeKey`. Bounded in length only. */
  nodeKey: z.string().min(1).max(120),
  x: coordinate,
  y: coordinate,
});

export const setAutomationViewSchema = z.object({
  view: z.enum(["CANVAS", "TABLE"]),
});

export const setAutoPublishSchema = z.object({
  kind: z.enum(["SERIES", "TOPIC_QUEUE"]),
  id: z.string().uuid(),
  enabled: z.boolean(),
  visibility: z.enum(["PUBLIC", "UNLISTED", "PRIVATE"]),
});
```

- [ ] **Step 3: Write the actions**

`setAutoPublishAction` must go through the owning service rather than `prisma` directly, so the ownership check the rest of the app relies on still runs. For a series that is `prisma.series.updateMany({ where: { id, userId }, ... })` guarded by `requireUser`; for a standalone schedule the same on `schedule`, additionally requiring `seriesId: null` — a series-owned schedule's copy is dead data and writing it would create exactly the "setting the screen shows and the worker ignores" state Plan 1 avoided.

Each action ends with `revalidatePath("/automation")`.

- [ ] **Step 4: Lint, typecheck, commit**

---

### Task 6: The canvas components

**Files:**
- Create: `automation-canvas.tsx`, `nodes/channel-node.tsx`, `nodes/automation-node.tsx`, `nodes/publish-node.tsx`, `use-node-positions.ts`
- Modify: `src/app/globals.css`

**Interfaces:**
- Consumes: `CanvasModel` (Task 4), `connectionOutcome` / `autoPlace` (Task 3), `AUTOMATION_KINDS`, the actions (Task 5).
- Produces: `<AutomationCanvas model={...} />`.

- [ ] **Step 1: Theme React Flow to the app's tokens**

React Flow ships its own stylesheet and its own colours. Import `@xyflow/react/dist/style.css` once in `automation-canvas.tsx`, then override in `globals.css` so the canvas is not the one surface in the app that ignores the accent and the dark theme:

```css
/* React Flow paints its own greys. The canvas is a studio surface like any
   other, so its background, edges and controls read from the same tokens
   everything else does — otherwise it is the one screen that ignores the
   operator's accent and stays light in dark mode. */
.react-flow {
  --xy-background-color: var(--background);
  --xy-edge-stroke: var(--border);
  --xy-edge-stroke-selected: var(--primary);
  --xy-controls-button-background-color: var(--card);
  --xy-controls-button-color: var(--foreground);
  --xy-minimap-background-color: var(--card);
}
```

- [ ] **Step 2: `use-node-positions.ts` — optimistic move, debounced save**

Local state is authoritative while dragging; the server write is debounced so a drag does not fire a request per frame.

```ts
/** How long after the last drag movement the position is written.
 *
 *  A drag emits a position per animation frame. Writing each one would be
 *  sixty requests a second per node; writing only on drag *end* would lose the
 *  position if the tab closed mid-gesture. 400ms after the last movement is
 *  one request per gesture in practice, and a gesture abandoned halfway still
 *  persists what was reached. */
const SAVE_DELAY_MS = 400;
```

- [ ] **Step 3: The node cards**

Each reads `AUTOMATION_KINDS[entry.kind]` for its icon, label and nouns — no `switch (kind)` anywhere. The automation card shows: kind badge, name, health badge (reuse `describeHealth`), cadence sentence, `backlog` with `backlogNoun`, and **`produced` / `published`** as the headline pair the operator asked for.

- [ ] **Step 4: `automation-canvas.tsx`**

`isValidConnection` calls `connectionOutcome` and returns its `.valid`. `onConnect` dispatches on `.action`. Nodes with no saved position get `autoPlace`. Include `<Background />`, `<Controls />`, `<MiniMap />`.

- [ ] **Step 5: Verify visually**

Run `pnpm dev` and drive a browser: the canvas renders, a node drags and its position survives a reload, an invalid target greys out mid-drag, and the whole thing is legible in dark mode.

- [ ] **Step 6: Commit**

---

### Task 7: The page and the toggle

**Files:**
- Create: `src/features/automation/components/view-toggle.tsx`
- Modify: `src/app/(dashboard)/automation/page.tsx`

- [ ] **Step 1: The toggle**

Two buttons, current view from `UserSetting.automationView`, switching via `setAutomationViewAction`. Server-rendered from the setting so there is no flash of the wrong view.

- [ ] **Step 2: The page**

Read the setting alongside the existing `getSetup` / `list` calls, render `<AutomationCanvas>` or `<AutomationTable>`. The `PageHeader`, `ReadinessNotice`, `NewAutomationMenu` and `EmptyState` are unchanged and shared by both views — an account with no automations sees the same empty state whichever view is selected, because an empty canvas is a worse dead end than an empty table.

- [ ] **Step 3: Update the page's doc comment**

The existing comment argues at length for "one table with one row per automation". That argument is still true of the *table*; what changed is that it is no longer the only view. Extend it rather than replacing it — say why a canvas answers "what is my kids channel doing" and why the table survives for "where is the one called Bedtime Stories".

- [ ] **Step 4: Verify, then commit**

---

## Self-Review

**Spec coverage.** Positions → Task 1. `published` / `autoPublish` on the read model → Task 2. Honest handles → Task 3. Grouping by channel → Task 4. The four real edits → Tasks 3 and 5. Node cards and inspector → Task 6. Canvas ⇄ Table toggle → Tasks 1 and 7.

**Placeholders.** Tasks 5, 6 and 7 give shape and rules rather than complete files, and that is deliberate rather than deferred: they are UI whose exact markup depends on components the implementer will be reading anyway (`release.action.ts`'s return shape, `AUTOMATION_KINDS`' fields, the existing `PageHeader`). Every *decision* in them is stated. If that proves too thin in execution, stop and expand the task rather than guessing.

**Type consistency.** `CanvasNodeRef` / `ConnectionOutcome` are defined in Task 3 and consumed in Task 6. `CanvasModel` is defined in Task 4 and consumed in Tasks 6 and 7. `moveNode(userId, nodeKey, x, y)` is defined in Task 4 and called by Task 5's action with that order.

**One open risk, stated rather than hidden:** Task 2 assumes `prisma.video.groupBy` accepts a `publication: { is: { status } }` filter. If Prisma 7 rejects a relation filter inside `groupBy`'s `where`, fall back to the two-step the `loadReleaseCadences` loader already uses — group the ids, then filter them in a second `findMany` — rather than a per-row count.

## What this plan does not do

- Free-form wiring between arbitrary nodes. See `valid-connections.ts`.
- Persisting zoom or pan.
- Editing a video from the canvas. Nodes link to the pages that exist.
- Any mobile-specific canvas behaviour. That is the next project, and the canvas will be part of its sweep.
