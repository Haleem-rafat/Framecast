"use client";

import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import "@xyflow/react/dist/style.css";

import { setAutoPublishAction } from "@/actions/canvas.action";
import { autoPlace, type Point } from "@/features/automation/canvas/auto-place";
import { branchColour } from "@/features/automation/canvas/branch-colour";
import { NodeInspector } from "@/features/automation/canvas/node-inspector";
import { AutomationNode } from "@/features/automation/canvas/nodes/automation-node";
import { ChannelNode } from "@/features/automation/canvas/nodes/channel-node";
import { PublishNode } from "@/features/automation/canvas/nodes/publish-node";
import {
  ReparentDialog,
  type PendingMove,
} from "@/features/automation/canvas/reparent-dialog";
import { useNodePositions } from "@/features/automation/canvas/use-node-positions";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  connectionOutcome,
  type CanvasNodeRef,
} from "@/features/automation/canvas/valid-connections";
import type { CanvasModel } from "@/services/canvas.service";

/**
 * The automation canvas.
 *
 * ## What is stored and what is derived
 *
 * Positions are the operator's and are read from `model.positions`. Everything
 * else on screen — which nodes exist, which edges join them, what each says —
 * is derived from `model.branches` on every render, because it is a projection
 * of rows that the rest of the app is free to change. A node the operator has
 * never moved is placed by `autoPlace`; nothing is laid out automatically after
 * that, ever, because a canvas that tidies up is a canvas that throws away the
 * arrangement the feature exists to preserve.
 *
 * ## The edges are not free
 *
 * `isValidConnection` runs `connectionOutcome` during the drag, so every
 * invalid target greys out before a drop rather than being refused after one.
 * See that module for why: unlike the positions, every edge here is a foreign
 * key, and a canvas that refuses most drops after you make them teaches its
 * operator not to trust it.
 */

/** Horizontal distance between a branch's columns: channel, automation,
 *  publish. Wide enough that a 288px automation card and its edge do not
 *  crowd the node either side. */
const COLUMN = 340;

/** Vertical distance between branches, and between automations within one.
 *  Sized to the tallest card a branch can hold. */
const ROW = 220;

const NODE_TYPES = {
  channel: ChannelNode,
  automation: AutomationNode,
  publish: PublishNode,
};

/** The node key vocabulary, in one place. It is what `CanvasNode.nodeKey`
 *  stores, so a second spelling anywhere would silently orphan a position. */
const channelKey = (id: string | null) => `channel:${id ?? "unrooted"}`;
const automationKey = (rowId: string) => rowId;
const publishKey = (rowId: string) => `publish:${rowId}`;

interface BuiltGraph {
  nodes: Node[];
  edges: Edge[];
}

function buildGraph(model: CanvasModel): BuiltGraph {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  // Every position already committed to, saved or auto-placed, so `autoPlace`
  // can see what is taken as the graph is built rather than only what was
  // saved.
  const taken: Point[] = [];

  const place = (key: string, anchor: Point): Point => {
    const saved = model.positions[key];
    const point = saved ?? autoPlace(taken, anchor);

    taken.push(point);

    return point;
  };

  model.branches.forEach((branch, branchIndex) => {
    const branchTop = branchIndex * ROW * 2;
    const chKey = channelKey(branch.channel?.id ?? null);

    const produced = branch.automations.reduce((sum, entry) => sum + entry.produced, 0);
    const published = branch.automations.reduce((sum, entry) => sum + entry.published, 0);
    // One colour per branch, derived once here and handed to every node and
    // edge in it. Computed in the builder rather than in each node so a card
    // and the edge reaching it can never disagree about which branch they are.
    const colour = branchColour(branch.channel?.id ?? null);
    // `branchColour` solves a PAIR because one value cannot sit legibly on
    // both grounds (see branch-colour.ts). Reading only `.light` left the
    // node's icon chip at 2.55-2.67:1 on the dark theme, under the 3:1
    // floor for non-text, and edges at 3.5-4.2:1 where 7.6-8.2:1 was
    // intended. `light-dark()` needs `color-scheme` to be declared, which
    // `appearance.tsx` already does, and unlike `useTheme` it cannot
    // mismatch between server and client.
    const tint = `light-dark(${colour.light}, ${colour.dark})`;

    nodes.push({
      id: chKey,
      type: "channel",
      position: place(chKey, { x: 0, y: branchTop }),
      data: {
        channelId: branch.channel?.id ?? null,
        title: branch.channel?.title ?? "No channel",
        automationCount: branch.automations.length,
        produced,
        published,
        tint,
      },
    });

    branch.automations.forEach((entry, index) => {
      const aKey = automationKey(entry.rowId);
      const anchor = { x: COLUMN, y: branchTop + index * ROW };

      nodes.push({
        id: aKey,
        type: "automation",
        position: place(aKey, anchor),
        data: { entry, tint },
      });

      edges.push({
        id: `${chKey}->${aKey}`,
        source: chKey,
        target: aKey,
        // Animated only while the automation is actually going to run. A dashed
        // line crawling towards a paused show would be the canvas asserting
        // that work is flowing when none is.
        animated: entry.status === "ACTIVE",
        style: {
          stroke: tint,
          strokeWidth: 2,
          // A paused branch keeps its colour and loses its confidence.
          opacity: entry.status === "ACTIVE" ? 1 : 0.4,
        },
      });

      // Null means the kind cannot publish itself — a shorts drip, which
      // publishes by definition. Disabled is drawn; absent is not.
      if (!entry.autoPublish) return;

      const pKey = publishKey(entry.rowId);

      nodes.push({
        id: pKey,
        type: "publish",
        position: place(pKey, { x: COLUMN * 2, y: anchor.y }),
        data: {
          automationId: entry.id,
          automationName: entry.name,
          enabled: entry.autoPublish.enabled,
          visibility: entry.autoPublish.visibility,
        },
      });

      edges.push({
        id: `${aKey}->${pKey}`,
        source: aKey,
        target: pKey,
        animated: entry.autoPublish.enabled,
        style: entry.autoPublish.enabled
          ? { stroke: tint, strokeWidth: 2 }
          : // Dashed and faint: the connection exists as an offer, and nothing
            // is travelling along it.
            { stroke: tint, strokeWidth: 2, strokeDasharray: "6 4", opacity: 0.35 },
      });
    });
  });

  return { nodes, edges };
}

/** Turns a React Flow node back into the shape `connectionOutcome` reasons
 *  about. Kept beside `buildGraph` because the two agree on `data`'s shape and
 *  would have to change together. */
function refOf(node: Node | undefined, model: CanvasModel): CanvasNodeRef | null {
  if (!node) return null;

  if (node.type === "channel") {
    const channelId = (node.data as { channelId: string | null }).channelId;
    const branch = model.branches.find(
      (candidate) => (candidate.channel?.id ?? null) === channelId,
    );

    return {
      kind: "CHANNEL",
      id: channelId ?? "",
      hasReleaseCadence: Boolean(
        branch?.automations.some((entry) => entry.kind === "RELEASE_CADENCE"),
      ),
    };
  }

  if (node.type === "automation") {
    const entry = (node.data as { entry: { id: string; kind: CanvasNodeRef["automationKind"] } })
      .entry;

    return { kind: "AUTOMATION", id: entry.id, automationKind: entry.kind };
  }

  const automationId = (node.data as { automationId: string }).automationId;

  return { kind: "PUBLISH", id: automationId };
}

function Canvas({ model }: { model: CanvasModel }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const savePosition = useNodePositions();
  const isMobile = useIsMobile();

  const initial = useMemo(() => buildGraph(model), [model]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);

  /** Which automation the inspector is showing, by `rowId`. Held as an id
   *  rather than the entry itself so a refresh after an edit re-reads the row
   *  instead of leaving the panel showing what it was before the change. */
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);

  /** A move waiting on its confirmation. Null the rest of the time. */
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);

  const selected = useMemo(
    () =>
      model.branches
        .flatMap((branch) => branch.automations)
        .find((entry) => entry.rowId === selectedRowId) ?? null,
    [model, selectedRowId],
  );

  /**
   * The rows changed underneath us — an automation was paused, auto-publish was
   * switched on, a video published.
   *
   * Data is taken from the server; **position is not**. A node already on
   * screen keeps exactly where it is, and only a node that has just appeared
   * takes the position `buildGraph` worked out for it.
   *
   * That split is the whole fix for a card springing back after being dragged.
   * The save is debounced by 400ms, so any refresh inside that window — the
   * inspector toggling auto-publish, a revalidate from anywhere else, React
   * Strict Mode in development — used to hand back the *previous* stored
   * position and undo the drag in front of the operator. Treating the screen as
   * authoritative for position removes the race rather than narrowing it.
   *
   * A real `useEffect`, not a `useMemo`. The previous version called `setNodes`
   * during render, which is a React violation that happens to work until it
   * does not.
   */
  useEffect(() => {
    setNodes((current) => {
      const placed = new Map(current.map((node) => [node.id, node.position]));

      return initial.nodes.map((node) => {
        const held = placed.get(node.id);

        return held ? { ...node, position: held } : node;
      });
    });
    // Edges carry state now — animated while active, dashed while publishing is
    // off — so they have to be rebuilt too. Without this, switching
    // auto-publish on left its edge dashed until a full page load.
    setEdges(initial.edges);
  }, [initial, setNodes, setEdges]);

  /**
   * Saves where a drag finished.
   *
   * `onNodeDragStop` rather than watching `NodeChange`s. React Flow does not
   * guarantee a `position` on the final change of a gesture, so the previous
   * version's `change.position && !change.dragging` guard silently skipped some
   * drags entirely — the position was never sent and the node moved back on the
   * next render. This callback is handed the node itself, with its final
   * position, every time.
   *
   * The third argument is every node that moved, which is more than one when a
   * selection is dragged. Saving only the one under the cursor would strand the
   * rest.
   */
  const handleNodeDragStop = useCallback(
    (_event: unknown, _node: Node, dragged: Node[]) => {
      for (const node of dragged) {
        savePosition(node.id, node.position.x, node.position.y);
      }
    },
    [savePosition],
  );

  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      const source = refOf(
        nodes.find((node) => node.id === connection.source),
        model,
      );
      const target = refOf(
        nodes.find((node) => node.id === connection.target),
        model,
      );

      if (!source || !target) return false;

      return connectionOutcome(source, target).valid;
    },
    [nodes, model],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const source = refOf(
        nodes.find((node) => node.id === connection.source),
        model,
      );
      const target = refOf(
        nodes.find((node) => node.id === connection.target),
        model,
      );

      if (!source || !target) return;

      const outcome = connectionOutcome(source, target);

      if (!outcome.valid) {
        // Reached only if a drop slipped past `isValidConnection`. Showing the
        // sentence is still better than silence.
        toast.error("That connection is not possible", { description: outcome.reason });
        return;
      }

      if (outcome.action === "ENABLE_PUBLISH") {
        startTransition(async () => {
          const entry = model.branches
            .flatMap((branch) => branch.automations)
            .find((candidate) => candidate.id === source.id);

          const response = await setAutoPublishAction({
            kind: source.automationKind === "SERIES" ? "SERIES" : "TOPIC_QUEUE",
            id: source.id,
            enabled: true,
            // Keeps whatever visibility was already chosen rather than
            // asserting one. Turning the switch on from a canvas must not also
            // silently decide how public the videos are.
            visibility: entry?.autoPublish?.visibility ?? "PRIVATE",
          });

          if (!response.ok) {
            toast.error("Could not turn on publishing", {
              description: response.error.message,
            });
            return;
          }

          toast.success("This automation now publishes itself");
          router.refresh();
        });
        return;
      }

      if (outcome.action === "ATTACH_CADENCE") {
        // A shorts drip is `@unique` per channel and is created *on* a channel
        // rather than moved between them — there is no "move" that would not
        // really be a delete and a create, which would take its run history
        // with it.
        toast.info("Create the drip on that channel", {
          description:
            "A shorts drip belongs to one channel and cannot be moved. Make a " +
            "new one on the channel you want, and delete this one.",
        });
        return;
      }

      // REPARENT. Dropping a card is a cheap gesture and this one changes where
      // finished videos publish, so it asks — and it has to ask *which project*
      // anyway, which the canvas cannot infer. See `ReparentDialog`.
      //
      // Note the direction: the drag runs channel → automation, so the SOURCE
      // is the destination channel and the TARGET is the thing being moved.
      // That reads backwards and is right — the handle you pull from is the one
      // doing the adopting.
      const branch = model.branches.find(
        (candidate) => candidate.channel?.id === source.id,
      );
      const entry = model.branches
        .flatMap((candidate) => candidate.automations)
        .find((candidate) => candidate.id === target.id);

      if (!branch?.channel || !entry) return;

      setPendingMove({
        entry,
        channelId: branch.channel.id,
        channelTitle: branch.channel.title,
        projects: branch.projects,
      });
    },
    [nodes, model, router, startTransition],
  );

  return (
    /* Shorter on a phone, where 100vh−16rem leaves almost nothing after the
       header, the mobile dock and the browser's own chrome. `dvh` rather than
       `vh` because Safari's toolbar collapses on scroll and `vh` is measured
       against the *expanded* height — a canvas sized in `vh` is cut off by the
       toolbar for as long as it is showing. */
    <div className="relative h-[70dvh] min-h-[26rem] w-full overflow-hidden rounded-xl border md:h-[calc(100dvh-16rem)] md:min-h-[32rem]">
      <ReactFlow
        onNodeClick={(_event, node) => {
          // Only an automation has an inspector. A channel's own page is one
          // click away on its title, and a publish step has nothing to say that
          // its automation's panel does not say better.
          setSelectedRowId(node.type === "automation" ? node.id : null);
        }}
        onPaneClick={() => setSelectedRowId(null)}
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onNodeDragStop={handleNodeDragStop}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        // The operator's arrangement is the point, so nothing here reflows it.
        // `fitView` only ever adjusts the viewport.
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        proOptions={{ hideAttribution: false }}
        /* Touch. React Flow supports it out of the box; what it does not do is
           guess which gestures belong to the canvas and which to the page.
           Dragging with one finger pans the canvas, so a node has to be taken
           deliberately — `nodeDragThreshold` means a tap that moves a few
           pixels is still a tap and opens the inspector, rather than nudging
           the card and saving a position the operator never chose. */
        panOnDrag
        nodeDragThreshold={6}
        zoomOnPinch
        /* Off, and this is the one that makes the page usable on a phone.
           With it on, a two-finger scroll over the canvas zooms instead of
           scrolling the page — so an operator swiping past the canvas to reach
           what is under it finds themselves trapped in it. Pinch still
           zooms. */
        zoomOnScroll={false}
        preventScrolling={false}
        /* A phone has no cursor to hover with, so a double tap is how you get
           in close. */
        zoomOnDoubleClick
        minZoom={0.25}
        maxZoom={1.75}
      >
        <Background gap={16} />
        <Controls showInteractive={false} />
        {/* The minimap is a desktop affordance. On a 390px screen it covers an
            eighth of the canvas to show a picture of the canvas, and the
            gesture it exists to replace — pinch to zoom out — is the one
            gesture a phone does better than a mouse. */}
        {!isMobile && <MiniMap pannable zoomable />}
      </ReactFlow>

      {selected && (
        <NodeInspector entry={selected} onClose={() => setSelectedRowId(null)} />
      )}

      {pendingMove && (
        <ReparentDialog move={pendingMove} onDone={() => setPendingMove(null)} />
      )}
    </div>
  );
}

/**
 * `ReactFlowProvider` wraps the canvas rather than the app. Its context is only
 * needed by what is inside it, and mounting it at the layout level would put a
 * store on every screen for the sake of one.
 */
export function AutomationCanvas({ model }: { model: CanvasModel }) {
  return (
    <ReactFlowProvider>
      <Canvas model={model} />
    </ReactFlowProvider>
  );
}
