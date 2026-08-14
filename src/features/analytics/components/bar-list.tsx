import { cn } from "@/lib/utils";

export interface BarListItem {
  label: string;
  /** The magnitude the bar encodes. */
  value: number;
  /** Pre-formatted for display — the raw `value` is only ever used for width. */
  display: string;
}

interface BarListProps {
  items: BarListItem[];
  className?: string;
}

/**
 * Horizontal magnitude bars, one row per category.
 *
 * Widths are scaled to the largest value rather than to a total, so the
 * comparison the reader makes ("this one is about half that one") is the
 * comparison the geometry actually encodes. Every row carries its own label
 * and value, so identity never depends on colour — which matters here because
 * there is only one colour: this is a single-series chart, so a legend and a
 * per-category palette would both be noise.
 */
export function BarList({ items, className }: BarListProps) {
  const max = Math.max(...items.map((item) => item.value), 0);

  return (
    <div className={cn("space-y-3", className)}>
      {items.map((item) => (
        <div key={item.label} className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-4 text-sm">
            <span className="truncate">{item.label}</span>
            <span className="text-muted-foreground shrink-0 font-mono text-xs">
              {item.display}
            </span>
          </div>
          <div className="bg-muted h-2 w-full overflow-hidden rounded-sm">
            <div
              className="bg-primary h-full rounded-sm"
              // A real but tiny value would otherwise round to an invisible
              // sliver and read as zero; 2% is the smallest width that still
              // reads as "present but small".
              style={{
                width: max > 0 ? `${Math.max(2, (item.value / max) * 100)}%` : "0%",
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
