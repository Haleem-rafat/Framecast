"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Whether a CSS media query currently matches.
 *
 * `false` during server rendering, for the same reason as
 * `useAmbientEffectsAllowed`: the server has no viewport, so any answer it
 * gives is a guess, and a guess that disagrees with the browser is a hydration
 * mismatch. Rendering the no-match branch and correcting it in the hydration
 * commit is the honest version of that trade.
 *
 * This means a caller should always treat `false` as "the plain version",
 * never as "the small-screen version" — the plain version is what a crawler,
 * a reader-mode pass and the first paint will all get.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onStoreChange);
      return () => media.removeEventListener("change", onStoreChange);
    },
    [query],
  );

  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
