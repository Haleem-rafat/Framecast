"use client";

import { useState, type ReactNode } from "react";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

export interface FocusCard {
  title: string;
  caption: string;
  /** The thing being shown off. Rendered above the title. */
  children: ReactNode;
}

/**
 * Aceternity's FocusCards — pointing at one card racks the others out of focus.
 * A rack focus is a camera move, which is why this one earned its place on a
 * page about video rather than one of the flashier grids.
 *
 * Adapted from upstream:
 * - Cards carry arbitrary `children` instead of an `<img src>`. Framecast has
 *   no stock photography to put here and inventing screenshots of videos that
 *   were never made would be a lie, so each card renders a drawn diagram of the
 *   artefact it describes.
 * - `card: any` is replaced with a real type, and the caption is always visible
 *   rather than revealed on hover — text you can only reach with a mouse is
 *   text a phone reader never sees.
 * - `focusin`/`focusout` are handled alongside the pointer, so a card that ends
 *   up containing a link racks into focus when it is tabbed to rather than
 *   sitting blurred under the caret.
 * - The blur is dropped entirely under reduced motion. It is a transition on a
 *   filter, which is exactly the kind of thing that makes some people ill.
 */
export function FocusCards({
  cards,
  className,
}: {
  cards: FocusCard[];
  className?: string;
}) {
  const [focused, setFocused] = useState<number | null>(null);
  const reduceMotion = usePrefersReducedMotion();

  return (
    <div className={cn("grid gap-4 sm:gap-6 md:grid-cols-3", className)}>
      {cards.map((card, index) => {
        const dimmed = !reduceMotion && focused !== null && focused !== index;

        return (
          <div
            key={card.title}
            onMouseEnter={() => setFocused(index)}
            onMouseLeave={() => setFocused(null)}
            onFocus={() => setFocused(index)}
            onBlur={() => setFocused(null)}
            className={cn(
              "bg-card flex flex-col rounded-xl border p-4 transition duration-300 ease-out",
              dimmed && "scale-[0.99] opacity-60 blur-[2px]",
            )}
          >
            <div className="flex-1">{card.children}</div>
            <div className="mt-4 space-y-1">
              <h3 className="text-sm font-medium">{card.title}</h3>
              <p className="text-muted-foreground text-sm text-pretty">
                {card.caption}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
