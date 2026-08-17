"use client";

import { Handle, type HandleProps } from "@xyflow/react";

/**
 * A connection point sized for a finger.
 *
 * React Flow's default handle is 6px and this app's first pass drew them at
 * 12px, which is fine with a mouse and unusable with a thumb — Apple and
 * Google both put the floor for a touch target at around 44px, and a 12px dot
 * is a quarter of that in each direction.
 *
 * Growing the visible dot to 44px is not the answer either: the canvas would
 * be covered in circles larger than some of the text. So the dot stays small
 * and an invisible `::after` extends the hit area well past it — exactly the
 * trick `components/ui/switch.tsx` already uses for the same reason, which is
 * why the numbers here echo its.
 *
 * The visible dot does grow on hover, so pointing at one still says "this is
 * grabbable" before you press.
 */
export function CanvasHandle(props: HandleProps) {
  return (
    <Handle
      {...props}
      className={
        "!size-3.5 !border-2 !bg-background !border-primary/70 " +
        "transition-transform duration-150 hover:!scale-125 " +
        // The hit area, invisible and roughly 44px square around the dot.
        "after:absolute after:-inset-4 after:content-['']"
      }
    />
  );
}
