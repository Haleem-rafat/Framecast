"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onStoreChange: () => void) {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", onStoreChange);
  return () => media.removeEventListener("change", onStoreChange);
}

function getSnapshot() {
  return window.matchMedia(QUERY).matches;
}

function getServerSnapshot() {
  return false;
}

/**
 * Whether the visitor has asked their system for less motion.
 *
 * `useReducedMotion()` from `motion` reads the media query lazily and only in
 * the browser, so it returns `null` during server rendering. Any component that
 * branches on it therefore renders one tree on the server and, for a visitor
 * who does prefer reduced motion, a different one on hydration — a mismatch
 * React has to repair, and a frame or two of the animation nobody asked for.
 *
 * `useSyncExternalStore` is the escape hatch React provides for exactly this:
 * it renders `getServerSnapshot()` during hydration and then reconciles against
 * the real value in the same commit, before the browser paints.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
