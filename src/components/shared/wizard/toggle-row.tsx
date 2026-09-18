"use client";

import { useId, type ReactNode } from "react";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/**
 * One on/off decision as a card: what it is, a badge if it needs one, one line
 * of consequence, and the switch on the right.
 *
 * `children` is what the switch reveals — a follow-up question that has no
 * meaning while the answer is "off", such as the visibility an auto-published
 * video goes out as. Revealing it rather than always showing it is the same
 * choice the series form made: a setting left on screen for a feature that is
 * off invites somebody to set it and believe they have turned the feature on.
 */
export function ToggleRow({
  title,
  badge,
  description,
  checked,
  onCheckedChange,
  disabled,
  children,
}: {
  title: ReactNode;
  badge?: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const id = useId();

  return (
    <div
      className={cn(
        "bg-card rounded-xl border p-4 transition-colors",
        checked && "border-primary/60",
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <Label htmlFor={id} className="flex flex-wrap items-center gap-2 font-medium">
            {title}
            {badge}
          </Label>
          {description && (
            <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
              {description}
            </p>
          )}
        </div>
        <Switch
          id={id}
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
          className="mt-0.5"
        />
      </div>

      {checked && children && <div className="mt-4 border-t pt-4">{children}</div>}
    </div>
  );
}
