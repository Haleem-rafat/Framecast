"use client";

import { useSyncExternalStore } from "react";

const QUERIES = ["(prefers-reduced-motion: reduce)", "(pointer: coarse)"];

function subscribe(onStoreChange: () => void) {
  const media = QUERIES.map((q) => window.matchMedia(q));
  media.forEach((m) => m.addEventListener("change", onStoreChange));
  return () =>
    media.forEach((m) => m.removeEventListener("change", onStoreChange));
}

function getSnapshot() {
  return QUERIES.every((q) => !window.matchMedia(q).matches);
}

function getServerSnapshot() {
  return false;
}

/**
 * Whether this device should be given decorative, animated effects at all.
 *
 * Two questions, both of which have to be "no" before anything mounts:
 *
 *  - `prefers-reduced-motion` — the visitor has asked their system for less
 *    motion, and the honest answer to that is not to run the animation at a
 *    slower speed but not to run it.
 *  - `pointer: coarse` — a touchscreen. This one is not an accessibility
 *    nicety but arithmetic. The effects gated on this hook are a full-screen
 *    WebGL canvas and a cursor trail; on a phone the first is a frame loop
 *    draining a battery for something nobody can interact with, and the second
 *    is a `mousemove` listener that never fires.
 *
 * Deliberately false during server rendering, so the server and the first
 * client commit agree and nothing that draws is in the HTML. The real answer
 * lands in the same commit as hydration, before the browser paints, which is
 * what `useSyncExternalStore` buys over an effect — see
 * `use-prefers-reduced-motion.ts` for the longer version of that argument.
 *
 * Callers must branch on this to decide whether to *render* the effect, not
 * merely to pause it. "Not mounted" is the requirement; a paused canvas is
 * still a canvas, still a WebGL context, and still a download.
 */
export function useAmbientEffectsAllowed(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
