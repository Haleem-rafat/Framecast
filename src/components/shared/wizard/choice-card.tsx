"use client";

import { createContext, useContext, useId, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Large clickable cards standing in for a `<Select>`: every option visible at
 * once, each with enough words (or a picture) to choose between them without
 * opening anything.
 *
 * Real radios, visually hidden inside a `<label>`, for the reason
 * `StylePicker` gives: arrow-key traversal, form association and the
 * accessible name come from the platform instead of being reimplemented on a
 * div. The group is one `radiogroup` and the browser groups the inputs by
 * `name`, so Tab lands on the chosen card and the arrows move between them.
 *
 * `aside` sits *outside* the label on purpose. A ▶ preview button inside it
 * would select the card on every press — the opposite of "hear it before
 * choosing", which is `VoicePicker`'s rule and the same rule here.
 */

interface ChoiceGroupContext {
  name: string;
  value: string | null;
  onChange: (value: string) => void;
  disabled?: boolean;
}

const GroupContext = createContext<ChoiceGroupContext | null>(null);

export function ChoiceGroup({
  name,
  value,
  onChange,
  disabled,
  label,
  labelledBy,
  className,
  children,
}: {
  /** The radios' shared name. Two groups on one screen need two names. */
  name: string;
  /** `null` for "nothing chosen yet", which is a real state for most steps. */
  value: string | null;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** An accessible name, when there is no visible heading to point at. */
  label?: string;
  labelledBy?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <GroupContext.Provider value={{ name, value, onChange, disabled }}>
      <div
        role="radiogroup"
        aria-label={label}
        aria-labelledby={labelledBy}
        className={cn("grid gap-3", className)}
      >
        {children}
      </div>
    </GroupContext.Provider>
  );
}

export type ChoiceCardLayout =
  /** Media on the left, words in the middle, `aside` on the right. Lists. */
  | "row"
  /** Media on top, the title under it. Grids of previews. */
  | "tile"
  /** A tall picture with the label underneath. Horizontal rows of looks. */
  | "tall";

export function ChoiceCard({
  value,
  title,
  description,
  badge,
  media,
  aside,
  layout = "row",
  className,
}: {
  value: string;
  title: ReactNode;
  description?: ReactNode;
  /** Small pill after the title — "Your default", "Current". */
  badge?: ReactNode;
  /** A swatch, an icon, a picture or a live preview. */
  media?: ReactNode;
  /** Interactive content that must not select the card — a preview button. */
  aside?: ReactNode;
  layout?: ChoiceCardLayout;
  className?: string;
}) {
  const group = useContext(GroupContext);
  const inputId = useId();

  if (!group) {
    throw new Error("ChoiceCard must be rendered inside a ChoiceGroup.");
  }

  const checked = group.value === value;

  return (
    <div
      className={cn(
        "bg-card relative flex rounded-xl border transition-colors",
        "focus-within:ring-ring/50 focus-within:ring-3",
        checked
          ? "border-primary bg-primary/5 ring-primary ring-1"
          : "hover:border-muted-foreground/40",
        group.disabled && "opacity-60",
        layout === "row" ? "items-center gap-3 p-4" : "flex-col",
        className,
      )}
    >
      <label
        htmlFor={inputId}
        className={cn(
          "flex min-w-0 flex-1 cursor-pointer",
          layout === "row" ? "items-center gap-3" : "flex-col",
          group.disabled && "cursor-not-allowed",
        )}
      >
        <input
          id={inputId}
          type="radio"
          name={group.name}
          value={value}
          checked={checked}
          disabled={group.disabled}
          onChange={() => group.onChange(value)}
          className="sr-only"
        />

        {media && (
          <span
            className={cn(
              "block shrink-0",
              layout === "tile" && "p-3 pb-0",
              layout === "tall" && "overflow-hidden rounded-t-xl",
            )}
          >
            {media}
          </span>
        )}

        <span
          className={cn(
            "flex min-w-0 flex-col gap-1",
            layout === "row" ? "flex-1" : "p-3",
          )}
        >
          <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {title}
            {badge}
          </span>
          {description && (
            <span className="text-muted-foreground text-xs leading-relaxed text-pretty">
              {description}
            </span>
          )}
        </span>
      </label>

      {aside && <div className="shrink-0">{aside}</div>}
    </div>
  );
}
