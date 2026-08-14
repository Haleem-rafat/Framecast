import type { ReactNode } from "react";

import { GlowingEffect } from "@/components/ui/glowing-effect";
import { cn } from "@/lib/utils";

/**
 * Aceternity's BentoGrid. Chosen over the fancier card components precisely
 * because it has no JavaScript in it at all — it stays a server component, so a
 * nine-item feature grid costs the bundle nothing.
 *
 * Adapted from upstream:
 * - `border-neutral-200 bg-white dark:border-white/[0.2] dark:bg-black` and the
 *   two hard-coded `text-neutral-*` values are replaced by `--card`/`--border`
 *   /`--muted-foreground`, so the grid takes the marketing palette.
 * - The registry lists `@tabler/icons-react` as a dependency, but only its demo
 *   ever imported it. It was uninstalled again; icons here are lucide, like the
 *   rest of the project.
 * - The hover state is a colour lift rather than upstream's
 *   `group-hover:translate-x-2`, which nudges the text sideways and makes the
 *   whole grid feel loose.
 * - Each tile carries a `GlowingEffect`, so the border lights up in the
 *   marketing palette and points back at the cursor. That component only does
 *   work while a pointer is over the tile it belongs to, so an idle grid costs
 *   nothing.
 */
export function BentoGrid({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        // `minmax(17rem, auto)`, not a flat `17rem`: 17rem is a floor that
        // keeps short tiles from collapsing, and a ceiling would be a promise
        // the content cannot keep. At `md` each column is only ~230px wide, so
        // the longer descriptions run to eight or nine lines and a fixed track
        // cannot hold them — the text spills past the card's border and over
        // the row beneath, which is what makes one tile look like it is
        // hanging out of the grid and the one behind it look half empty.
        // Rows now grow to their tallest tile and the rest stretch to match.
        "grid grid-cols-1 gap-4 md:auto-rows-[minmax(17rem,auto)] md:grid-cols-3",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function BentoGridItem({
  className,
  title,
  description,
  header,
  icon,
}: {
  className?: string;
  title?: ReactNode;
  description?: ReactNode;
  /** The visual half of the tile, above the words. */
  header?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "group/bento bg-card hover:border-brand-violet/40 relative flex flex-col justify-between gap-4 rounded-xl border p-4 transition-colors duration-300",
        className,
      )}
    >
      <GlowingEffect />
      {header}
      <div>
        {icon}
        <h3 className="mt-2 text-sm font-medium">{title}</h3>
        <p className="text-muted-foreground mt-1 text-sm text-pretty">
          {description}
        </p>
      </div>
    </div>
  );
}
