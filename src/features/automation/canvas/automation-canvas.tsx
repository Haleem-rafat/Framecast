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
  type NodeChange,
} from "@xyflow/react";
import { useCallback, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import "@xyflow/react/dist/style.css";

import { setAutoPublishAction } from "@/actions/canvas.action";
import { autoPlace, type Point } from "@/features/automation/canvas/auto-place";
import { NodeInspector } from "@/features/automation/canvas/node-inspector";
import { AutomationNode } from "@/features/automation/canvas/nodes/automation-node";
import { ChannelNode } from "@/features/automation/canvas/nodes/channel-node";
import { PublishNode } from "@/features/automation/canvas/nodes/publish-node";
import { useNodePositions } from "@/features/automation/canvas/use-node-positions";
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
      },
    });

    branch.automations.forEach((entry, index) => {
      const aKey = automationKey(entry.rowId);
      const anchor = { x: COLUMN, y: branchTop + index * ROW };

      nodes.push({
        id: aKey,
        type: "automation",
        position: place(aKey, anchor),
        data: { entry },
      });

      edges.push({
        id: `${chKey}->${aKey}`,
        source: chKey,
        target: aKey,
        animated: entry.status === "ACTIVE",
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
        style: entry.autoPublish.enabled ? undefined : { strokeDasharray: "6 4" },
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

  const initial = useMemo(() => buildGraph(model), [model]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, , onEdgesChange] = useEdgesState(initial.edges);

  /** Which automation the inspector is showing, by `rowId`. Held as an id
   *  rather than the entry itself so a refresh after an edit re-reads the row
   *  instead of leaving the panel showing what it was before the change. */
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);

  const selected = useMemo(
    () =>
      model.branches
        .flatMap((branch) => branch.automations)
        .find((entry) => entry.rowId === selectedRowId) ?? null,
    [model, selectedRowId],
  );

  // The rows changed underneath us — an automation was paused, a video
  // published. Rebuild rather than merge: everything but the positions is
  // derived, and the positions are in `model` too.
  useMemo(() => {
    setNodes(initial.nodes);
  }, [initial.nodes, setNodes]);

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      onNodesChange(changes);

      for (const change of changes) {
        // `dragging: false` is the end of a gesture. Positions during one are
        // local only — see `useNodePositions` for why this is debounced rather
        // than fired per frame.
        if (change.type === "position" && change.position && !change.dragging) {
          savePosition(change.id, change.position.x, change.position.y);
        }
      }
    },
    [onNodesChange, savePosition],
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

      // REPARENT and ATTACH_CADENCE both move an automation between channels,
      // which changes where finished videos go. That is not a drag-and-drop
      // decision — it is one the form makes with the project picker in front of
      // it and `assertRecipe` behind it — so the canvas points at the form
      // rather than performing it.
      toast.info("Open the automation to move it", {
        description:
          "Moving an automation to another channel changes where its finished " +
          "videos publish, so it is done on its own page where the project and " +
          "channel are shown together.",
      });
    },
    [nodes, model, router, startTransition],
  );

  return (
    <div className="relative h-[calc(100vh-16rem)] min-h-[32rem] w-full overflow-hidden rounded-xl border">
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
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        // The operator's arrangement is the point, so nothing here reflows it.
        // `fitView` only ever adjusts the viewport.
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        proOptions={{ hideAttribution: false }}
      >
        <Background gap={16} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
      </ReactFlow>

      {selected && (
        <NodeInspector entry={selected} onClose={() => setSelectedRowId(null)} />
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
