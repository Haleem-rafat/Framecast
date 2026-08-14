"use client";

import type { CSSProperties } from "react";
import { Check } from "lucide-react";

import type { AccentColour } from "@/generated/prisma/enums";
import { ACCENTS, ACCENT_ORDER, formatOklch } from "@/lib/accent";
import { cn } from "@/lib/utils";

interface AccentPickerProps {
  value: AccentColour;
  onChange: (value: AccentColour) => void;
}

/**
 * The swatch grid.
 *
 * Built on real `<input type="radio">` elements rather than buttons with
 * `role="radio"`. A radio group has keyboard behaviour a screen reader user
 * expects — arrow keys move between options, Tab enters and leaves the group as
 * one stop — and the browser implements all of it for free from a shared
 * `name`. Re-implementing that with roving `tabIndex` is the kind of thing that
 * is 90% right and then wrong in the way that matters.
 *
 * Every swatch carries its name in text underneath, not only in its colour.
 * A grid whose options differ *only* by hue is unusable to someone who cannot
 * distinguish the hues — which, in a control specifically for choosing a colour,
 * would be a particularly poor joke.
 */
export function AccentPicker({ value, onChange }: AccentPickerProps) {
  return (
    <fieldset>
      <legend className="sr-only">Accent colour</legend>

      <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-11">
        {ACCENT_ORDER.map((name) => {
          const definition = ACCENTS[name];
          const selected = value === name;

          return (
            <label
              key={name}
              className="group flex cursor-pointer flex-col items-center gap-1.5"
              style={
                {
                  // The swatch has to show the colour the operator will
                  // actually get, and that differs per theme — an accent is a
                  // derived pair, not one value. Both are handed to CSS and the
                  // `dark:` variant picks the right one, so the grid restyles
                  // itself when the theme changes with no JS involved.
                  "--swatch-light": formatOklch(definition.light.primary),
                  "--swatch-dark": formatOklch(definition.dark.primary),
                } as CSSProperties
              }
            >
              <input
                type="radio"
                name="accent"
                value={name}
                checked={selected}
                onChange={() => onChange(name)}
                className="peer sr-only"
              />

              <span
                aria-hidden
                className={cn(
                  "flex size-8 items-center justify-center rounded-full",
                  "bg-(--swatch-light) dark:bg-(--swatch-dark)",
                  // The border keeps the near-white dark-theme GRAPHITE swatch
                  // from vanishing into a light card, and vice versa.
                  "border-foreground/10 border",
                  "transition-transform group-hover:scale-110",
                  // Selection is a ring *and* a tick: on this control the
                  // selected item is the one thing that must not be indicated
                  // by colour alone.
                  selected && "ring-foreground ring-2 ring-offset-2",
                  "ring-offset-background",
                  "peer-focus-visible:ring-ring peer-focus-visible:ring-3 peer-focus-visible:ring-offset-2",
                )}
              >
                {/* `--primary-foreground` rather than a hardcoded white: the
                    selected swatch *is* `--primary` while the preview is live,
                    so this is the one pairing accent.test.ts already proves
                    clears 4.5:1 in both themes. */}
                {selected && (
                  <Check
                    className="text-primary-foreground size-4"
                    strokeWidth={3}
                  />
                )}
              </span>

              <span
                className={cn(
                  "text-center text-[0.7rem] leading-tight",
                  selected
                    ? "text-foreground font-medium"
                    : "text-muted-foreground",
                )}
              >
                {definition.label}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
