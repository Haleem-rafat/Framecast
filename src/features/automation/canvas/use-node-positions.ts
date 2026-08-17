"use client";

import { useCallback, useEffect, useRef } from "react";

import { moveCanvasNodeAction } from "@/actions/canvas.action";

/**
 * Writes a node's position down, without writing it sixty times a second.
 *
 * A drag emits a position per animation frame. Sending each one would be sixty
 * requests a second per node; sending only on drag *end* loses the position if
 * the tab is closed mid-gesture, which on a canvas an operator is deliberately
 * arranging is exactly when they are most likely to be interrupted.
 *
 * So: debounce per node key. The last position of a gesture is written once,
 * shortly after movement stops, and a gesture abandoned halfway still persists
 * what it reached.
 *
 * Per *key*, not one timer for the whole canvas — dragging node B must not
 * cancel the pending save for node A. That is the bug the obvious single-timer
 * version has, and it loses positions silently.
 */

/** How long after the last movement a position is written. Long enough that one
 *  gesture is one request in practice; short enough that letting go and closing
 *  the tab keeps the arrangement. */
const SAVE_DELAY_MS = 400;

export function useNodePositions() {
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // Clears on unmount so a navigation mid-drag does not fire an action against
  // a page that has gone. The positions already written stand; the one in
  // flight is the one the operator abandoned by leaving.
  useEffect(() => {
    const pending = timers.current;

    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return useCallback((nodeKey: string, x: number, y: number) => {
    const existing = timers.current.get(nodeKey);

    if (existing) clearTimeout(existing);

    timers.current.set(
      nodeKey,
      setTimeout(() => {
        timers.current.delete(nodeKey);
        // Deliberately not awaited and deliberately not toasted on failure.
        // The node is already where the operator put it; a failed *position*
        // write costs them a remembered coordinate, and interrupting an
        // arranging session with an error toast about it would be a worse
        // trade than losing the coordinate.
        void moveCanvasNodeAction({ nodeKey, x, y });
      }, SAVE_DELAY_MS),
    );
  }, []);
}
