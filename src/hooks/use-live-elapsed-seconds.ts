"use client";

import { useEffect, useState } from "react";

/**
 * A server-sent elapsed time, advancing between polls.
 *
 * The number arrives every few seconds and then sits still, so a clock driven
 * straight off it visibly stutters — it is the one number on a page an operator
 * watches second by second, and a multi-second step reads as the page having
 * frozen. This adds the wall-clock time since that number arrived, which is not
 * an estimate: the server said "N seconds as of `dataUpdatedAt`", and time has
 * genuinely passed since.
 *
 * Deliberately *not* a second polling loop. `setInterval` here only re-renders
 * the calling component; it never touches the network, and it stops the moment
 * the thing being timed does — a finished render's elapsed time is frozen,
 * which is the truth.
 *
 * Lives here rather than beside its first caller because it now smooths two
 * different clocks that must not drift apart in behaviour: the render's elapsed
 * time in `pipeline-panel.tsx`, and a publish upload's in
 * `publish-attempt-panel.tsx`. Both are "a server-written duration, polled" and
 * a second implementation of that would be a second set of edge cases around
 * clock skew and stopped timers.
 */
export function useLiveElapsedSeconds(
  elapsedSeconds: number | null,
  dataUpdatedAt: number,
  ticking: boolean,
): number | null {
  const [now, setNow] = useState(dataUpdatedAt);

  useEffect(() => {
    if (!ticking) return;

    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(id);
  }, [ticking]);

  if (elapsedSeconds === null) return null;
  if (!ticking) return elapsedSeconds;

  // `Math.max(0, …)` because a clock skew between this browser and the server
  // must never make the timer run backwards.
  return elapsedSeconds + Math.max(0, Math.floor((now - dataUpdatedAt) / 1000));
}
