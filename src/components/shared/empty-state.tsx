import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Card, CardContent } from "@/components/ui/card";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: EmptyStateProps) {
  return (
    <Card className="border-dashed shadow-none">
      <CardContent className="flex flex-col items-center justify-center gap-3 py-14 text-center">
        <div className="bg-muted text-muted-foreground flex size-11 items-center justify-center rounded-full">
          <Icon className="size-5" />
        </div>
        <div className="space-y-1">
          {/* An `<h3>`, not a `<p>`. This is the only content in the region it
            * replaces — a table, a card list — and a screen-reader user
            * skimming by heading would otherwise pass straight over the one
            * line explaining why the section looks empty. h3 rather than h2
            * because empty states sit inside a card that is already a
            * subsection of the page's h1. */}
          <h3 className="font-medium">{title}</h3>
          <p className="text-muted-foreground mx-auto max-w-sm text-sm text-balance">
            {description}
          </p>
        </div>
        {action && <div className="pt-1">{action}</div>}
      </CardContent>
    </Card>
  );
}
