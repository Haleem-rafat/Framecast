import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  description?: string;
  /** Primary actions, rendered right-aligned on desktop. */
  actions?: ReactNode;
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    // `items-start`, not `items-center`. Centring worked while every page had a
    // one-line description and one button; a two-line description beside three
    // controls pulled the buttons into the middle of the text block and left
    // ragged space above and below them. Aligning to the top means the heading
    // and the first action share a baseline however long either grows.
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          // Capped rather than left to fill the row. A description running the
          // full width of a wide screen is a line nobody finishes reading, and
          // it is what pushed the actions into a narrow column beside it.
          <p className="text-muted-foreground max-w-2xl text-sm text-pretty">
            {description}
          </p>
        )}
      </div>
      {/* Wraps, and stays put at the end of the row. Without `shrink-0` a long
          description squeezes the buttons until their labels wrap one word per
          line, which is what a header with three controls in it does on a
          laptop. */}
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
