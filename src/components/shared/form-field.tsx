"use client";

import { useId, type ReactNode } from "react";

import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { cn } from "@/lib/utils";

/**
 * One labelled control in a studio form.
 *
 * This exists for the same reason `AuthField` exists under `(auth)`: every form
 * in the dashboard had hand-assembled `<div className="space-y-2">` + `<Label>`
 * + control + `<p className="text-destructive text-xs">`, and six copies of a
 * pattern is six chances for the spacing, the error voice and the accessibility
 * wiring to drift — which is exactly what had happened. `components/ui/field`
 * was in the repo the whole time and imported by precisely one file.
 *
 * What the hand-rolled version kept getting wrong, and what this fixes by
 * construction rather than by review:
 *
 * - **Errors were invisible to screen readers.** A bare `<p>` announces nothing
 *   when it appears. `FieldError` is `role="alert"`, so a failed submit is
 *   spoken instead of silently redrawn.
 * - **Nothing was wired to its control.** `aria-describedby` appeared zero
 *   times across the whole dashboard, so an error was on screen next to a field
 *   but not attached to it — a screen reader user tabbing into the input heard
 *   the label and nothing else. The render prop below makes that wiring
 *   impossible to forget: you cannot render the control without receiving it.
 * - **`aria-invalid` was applied to inputs but skipped on every select**, so a
 *   select that failed validation printed a message and still drew itself as
 *   healthy.
 * - **Errors were `text-xs` where the design system says `text-sm`**, making
 *   the most important text in a failed form the smallest text on the page.
 */

/**
 * What `FormField` hands back to the control. Spread it onto whatever the
 * caller renders — `Input`, `Textarea`, `SelectTrigger` — and the label
 * association, the invalid state and the description link are all correct.
 */
export interface FormControlProps {
  id: string;
  "aria-invalid": boolean;
  "aria-describedby": string | undefined;
}

interface FormFieldProps {
  /**
   * The field's name in the form. Only ever used to build a readable, unique
   * DOM id — never rendered — so it does not have to match the resolver's key,
   * though it reads better when it does.
   */
  name: string;
  label: ReactNode;
  /**
   * Standing hint. Shares a slot with `error` and is replaced by it, never
   * stacked, so the field keeps its height when a submit fails and the button
   * below it does not jump out from under the pointer mid-click.
   */
  description?: ReactNode;
  /**
   * A disclosure that outlives an error — the settings page's "not used yet"
   * note, in practice. Unlike `description` this is always rendered, because it
   * describes what the control *does* rather than how to fill it in, and that
   * stays true while the value is invalid.
   */
  note?: ReactNode;
  /** The resolver's message for this field, if it currently has one. */
  error?: string;
  className?: string;
  children: (control: FormControlProps) => ReactNode;
}

export function FormField({
  name,
  label,
  description,
  note,
  error,
  className,
  children,
}: FormFieldProps) {
  /**
   * Ids come from `useId` rather than from `name` alone. Two dialogs on one
   * page both hard-coded `id="name"` before this — a duplicate id, which makes
   * a label click focus whichever control the browser found first. Prefixing
   * with a per-instance id also means a field array can render the same `name`
   * twice without collision.
   */
  const uid = useId();
  const id = `${uid}-${name}`;
  const messageId = `${id}-message`;
  const noteId = `${id}-note`;

  const hasMessage = Boolean(error) || Boolean(description);

  // Whatever is actually on screen, in reading order. `undefined` rather than
  // an empty string when there is nothing, because `aria-describedby=""` points
  // at an element that does not exist.
  const describedBy =
    [hasMessage ? messageId : null, note ? noteId : null]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <Field className={className}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>

      {children({
        id,
        "aria-invalid": Boolean(error),
        "aria-describedby": describedBy,
      })}

      {error ? (
        <FieldError id={messageId}>{error}</FieldError>
      ) : description ? (
        <FieldDescription id={messageId}>{description}</FieldDescription>
      ) : null}

      {note ? (
        <FieldDescription id={noteId} className="text-xs">
          {note}
        </FieldDescription>
      ) : null}
    </Field>
  );
}

/**
 * A field whose control is not a single focusable element — a radio group, a
 * table of rows — and therefore cannot be pointed at with `htmlFor`.
 *
 * Rendered as a `FieldTitle`-shaped heading rather than a `<label>`, because a
 * label that points at nothing is a label a screen reader reads out with no
 * control attached. The group itself is expected to carry its own accessible
 * name (a `<legend>`, or `aria-label` on the container).
 */
export function FormFieldset({
  label,
  description,
  note,
  className,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  note?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Field className={cn("gap-3", className)}>
      <div className="flex flex-col gap-1">
        <div className="text-sm leading-none font-medium">{label}</div>
        {description ? (
          <FieldDescription className="text-xs">{description}</FieldDescription>
        ) : null}
      </div>

      {children}

      {note ? (
        <FieldDescription className="text-xs">{note}</FieldDescription>
      ) : null}
    </Field>
  );
}
