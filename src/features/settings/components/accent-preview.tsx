"use client";

import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * A row of the controls an accent actually lands on.
 *
 * Nothing here is a mock-up: these are the real `Button` variants and the real
 * `--ring` / `--accent` tokens, so what this strip shows is definitionally what
 * the rest of the studio is already showing — the picker repaints the whole
 * page, not a swatch. The strip exists because "the whole page" is easy to miss
 * when the page you are on is a form: it puts a solid fill, a focus ring, a
 * link and a selected row within a few pixels of the swatches, where a glance
 * can compare them.
 *
 * The Delete button is here on purpose. `--destructive` is deliberately outside
 * the accent, so this is where an operator sees that red still means "this
 * removes something" even when their accent is itself red — meaning is never
 * carried by the accent alone.
 */
export function AccentPreview() {
  return (
    <div
      className="bg-muted/40 flex flex-wrap items-center gap-3 rounded-lg border p-3"
      // The strip is a sample of controls that appear elsewhere, not a set of
      // controls to operate — announcing every button in it would clutter the
      // form for a screen reader without adding anything, since the colour it
      // demonstrates is not perceivable there anyway.
      aria-hidden
    >
      <Button type="button" tabIndex={-1}>
        Generate video
      </Button>
      <Button type="button" variant="secondary" tabIndex={-1}>
        Cancel
      </Button>
      <Button type="button" variant="destructive" tabIndex={-1}>
        <Trash2 />
        Delete
      </Button>

      {/* Reproduces exactly what `Button`/`Input` render on `focus-visible`,
          because a focus ring is impossible to show while focus is elsewhere. */}
      <span className="border-ring ring-ring/50 text-muted-foreground rounded-lg border px-3 py-1.5 text-sm ring-3">
        Focused field
      </span>

      <span className="bg-accent text-accent-foreground rounded-lg px-3 py-1.5 text-sm">
        Selected row
      </span>

      <span className="text-primary text-sm underline underline-offset-4">
        A link
      </span>
    </div>
  );
}
