import type { ComponentProps, ReactNode } from "react";
import { Loader2, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * The shared parts of the four credential forms — the field, the submit button,
 * the provider divider and the form-level error. Extracted for the same reason
 * AuthShell was: four forms hand-assembling `Label` + `Input` + a red `<p>` is
 * four chances for the spacing, the focus ring and the error voice to drift.
 *
 * These are compositions of `components/ui/field` and `components/ui/input`,
 * not replacements for them. Everything below is a class on top of those
 * primitives; no field styling is re-implemented here.
 */

/**
 * The block every control in an (auth) form is cut to: 40px tall, 4px corner,
 * full width.
 *
 * Those are not our numbers — they are the geometry of the "Sign in with
 * Google" button, which Google's branding guidelines fix and which therefore
 * cannot move. The button used to sit under a 32px, 10px-radius submit button
 * and read as a foreign object pasted onto the form. The fix is this direction
 * and only this direction: the form is cut to Google's block, the button is
 * untouched. Restyling *it* to match *us* would mean recolouring or reshaping a
 * component whose appearance is contractual.
 *
 * The size happens to be the right call on its own merits. 40px is a
 * comfortable touch target at 375px wide, where the studio's denser 32px
 * controls are tight, and a 4px corner beside the card's 12px one reads as
 * deliberate hierarchy: the container is soft, the controls are crisp.
 */
export const authControlClassName = "h-10 w-full rounded-[4px]";

/**
 * A field's worth of vertical rhythm. `FieldGroup` defaults to a 20px gap,
 * which on the four-field sign-up form pushes the submit button off a short
 * laptop screen; 16px between fields and the card's own 20px between blocks
 * gives the form a rhythm of two clear steps instead of one flat list.
 */
export function AuthFieldGroup({
  className,
  ...props
}: ComponentProps<typeof FieldGroup>) {
  return <FieldGroup className={cn("gap-4", className)} {...props} />;
}

interface AuthFieldProps extends ComponentProps<"input"> {
  id: string;
  label: ReactNode;
  /** Sits opposite the label. The "Forgot password?" link, in practice. */
  labelAction?: ReactNode;
  /** Standing hint. Replaced by `error` when there is one, never stacked. */
  description?: ReactNode;
  /** The resolver's message for this field, if it currently has one. */
  error?: string;
}

/**
 * One labelled input, with its hint and its error in the same slot.
 *
 * The hint and the error share a line rather than stacking, so a field never
 * changes height when it fails and the button under it never jumps out from
 * under the cursor mid-click. `FieldError` carries `role="alert"`, and the
 * input points at whichever of the two is showing through `aria-describedby`,
 * so the message is both announced when it appears and reachable afterwards
 * from the field itself.
 */
export function AuthField({
  id,
  label,
  labelAction,
  description,
  error,
  className,
  ...inputProps
}: AuthFieldProps) {
  const messageId = error
    ? `${id}-error`
    : description
      ? `${id}-description`
      : undefined;

  return (
    <Field className="group/auth-field gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <FieldLabel
          htmlFor={id}
          className="text-foreground/85 text-[0.8125rem] transition-colors duration-150 group-has-[input:focus-visible]/auth-field:text-foreground"
        >
          {label}
        </FieldLabel>
        {labelAction}
      </div>

      <Input
        id={id}
        aria-invalid={Boolean(error)}
        aria-describedby={messageId}
        className={cn(
          authControlClassName,
          // A hair recessed against the card so the input reads as a well
          // rather than another panel, coming up to the full surface on focus.
          // Only the ring and the border move; the box never resizes, which is
          // what keeps the focus treatment from feeling like a jolt.
          "bg-background/40 px-3 transition-[color,background-color,border-color,box-shadow] duration-150 hover:border-foreground/25 focus-visible:bg-background dark:bg-input/25 dark:hover:border-foreground/30 dark:focus-visible:bg-input/40",
          className,
        )}
        {...inputProps}
      />

      {error ? (
        <FieldError
          id={messageId}
          // Slid in rather than snapped: an error that simply appears under a
          // field is easy to miss when the eye is still on the button that was
          // just pressed. CSS-driven, so `motion-reduce` genuinely removes it.
          className="animate-in fade-in slide-in-from-top-1 text-xs duration-200 motion-reduce:animate-none"
        >
          {error}
        </FieldError>
      ) : description ? (
        <FieldDescription id={messageId} className="text-xs">
          {description}
        </FieldDescription>
      ) : null}
    </Field>
  );
}

/**
 * The form's primary action, cut to the same block as the Google button below
 * it. `aria-busy` rather than only a disabled attribute, so the pending state
 * is announced and not merely drawn, and the label says which verb is running.
 */
export function AuthSubmitButton({
  isSubmitting,
  pendingLabel,
  children,
  className,
  ...props
}: ComponentProps<typeof Button> & {
  isSubmitting: boolean;
  /** What the button says while the request is in flight. */
  pendingLabel: string;
}) {
  return (
    <Button
      type="submit"
      disabled={isSubmitting}
      aria-busy={isSubmitting}
      className={cn(
        authControlClassName,
        "gap-2 text-sm leading-5 shadow-sm transition-[background-color,box-shadow,opacity,translate] hover:shadow-md",
        className,
      )}
      {...props}
    >
      {isSubmitting && <Loader2 className="animate-spin" />}
      {isSubmitting ? pendingLabel : children}
    </Button>
  );
}

/**
 * The rule between the credential form and the Google button. Two hairlines
 * fading into the label rather than one line with a chip sitting on it: the
 * card is translucent over a moving wash, so an opaque chip punched through the
 * middle of a rule would be visible as a lighter patch.
 */
export function AuthDivider({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3" aria-hidden="true">
      <span className="via-border/80 h-px flex-1 bg-gradient-to-r from-transparent to-transparent" />
      <span className="text-muted-foreground text-[0.6875rem] font-medium tracking-[0.1em] uppercase">
        {children}
      </span>
      <span className="via-border/80 h-px flex-1 bg-gradient-to-l from-transparent to-transparent" />
    </div>
  );
}

/**
 * Whatever the server said went wrong, at the top of the form where the eye
 * returns after a failed submit. `Alert` is already `role="alert"`, so mounting
 * it announces the message.
 */
export function AuthFormAlert({ children }: { children: ReactNode }) {
  return (
    <Alert
      variant="destructive"
      className="animate-in fade-in slide-in-from-top-1 border-destructive/30 bg-destructive/5 duration-200 motion-reduce:animate-none dark:bg-destructive/10"
    >
      <TriangleAlert />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
