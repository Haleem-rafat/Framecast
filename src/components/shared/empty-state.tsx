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
          <p className="font-medium">{title}</p>
          <p className="text-muted-foreground mx-auto max-w-sm text-sm text-balance">
            {description}
          </p>
        </div>
        {action && <div className="pt-1">{action}</div>}
      </CardContent>
    </Card>
  );
}
