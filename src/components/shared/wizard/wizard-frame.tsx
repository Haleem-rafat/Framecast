"use client";

import type { ReactNode } from "react";
import { ArrowLeft, ChevronRight, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The frame every step of a step-by-step flow sits in: a segmented progress
 * bar, a heading that says where you are, one decision, and Back / Continue.
 *
 * Built for the new-series flow and deliberately knowing nothing about it — a
 * later flow is meant to reuse these pieces — so every word on screen comes in
 * through props and nothing here decides what a step is or whether it is done.
 *
 * The column is capped at ~700px and centred. A wizard is one decision at a
 * time; a full-width card grid on a wide screen turns "pick one" into "scan a
 * spreadsheet", which is the thing the flow exists to stop.
 */
export function WizardFrame({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto w-full max-w-[700px] space-y-6", className)}>
      {children}
    </div>
  );
}

/**
 * One segment per step, filled up to and including the current one.
 *
 * A list with a visually-hidden label per segment rather than a single
 * `progressbar`: the useful fact for a screen reader is not "44%" but "step 4
 * of 9, Voice", which a percentage cannot say.
 */
export function WizardProgress({
  steps,
  current,
}: {
  steps: readonly { id: string; label: string }[];
  /** Zero-based index of the step on screen. */
  current: number;
}) {
  return (
    <ol aria-label="Progress" className="flex gap-1.5">
      {steps.map((step, index) => (
        <li
          key={step.id}
          aria-current={index === current ? "step" : undefined}
          className={cn(
            "h-1.5 flex-1 rounded-full transition-colors",
            index <= current ? "bg-primary" : "bg-muted",
          )}
        >
          <span className="sr-only">
            Step {index + 1} of {steps.length}: {step.label}
            {index < current ? " (done)" : index === current ? " (current)" : ""}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The small rounded label beside a step's heading. */
function StepPill({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-full font-medium",
        muted
          ? "text-muted-foreground"
          : "border-primary/30 bg-primary/10 text-primary",
      )}
    >
      {children}
    </Badge>
  );
}

export function WizardStepHeader({
  title,
  stepNumber,
  stepCount,
  optional,
  description,
  note,
  headingId,
}: {
  title: string;
  /** One-based, as the pill prints it. */
  stepNumber: number;
  stepCount: number;
  optional?: boolean;
  /** One short line. Anything longer belongs on the step itself, next to the
   *  choice it explains. */
  description?: ReactNode;
  /** A single qualifying line under the description — where the answer is
   *  stored, what it also changes. Kept visually quieter than the subtitle. */
  note?: ReactNode;
  /** So the step's choice group can be `aria-labelledby` the heading. */
  headingId?: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={headingId} className="text-xl font-semibold tracking-tight">
          {title}
        </h2>
        <StepPill>
          Step {stepNumber} of {stepCount}
        </StepPill>
        {optional && <StepPill muted>Optional</StepPill>}
      </div>
      {description && (
        <p className="text-muted-foreground text-sm text-pretty">{description}</p>
      )}
      {note && (
        <p className="text-muted-foreground bg-muted/40 rounded-md border px-3 py-2 text-xs">
          {note}
        </p>
      )}
    </div>
  );
}

/**
 * Back on the left, the forward action on the right, and — when forward is
 * refused — the reason in words beside it rather than a greyed button that
 * explains nothing.
 */
export function WizardFooter({
  onBack,
  onPrimary,
  primaryLabel = "Continue",
  primaryIcon,
  primaryDisabled,
  pending,
  blockedReason,
}: {
  /** Absent on the first step, where there is nowhere to go back to. */
  onBack?: () => void;
  onPrimary: () => void;
  primaryLabel?: string;
  /** Replaces the chevron, for a last step whose action is not "next". */
  primaryIcon?: ReactNode;
  primaryDisabled?: boolean;
  pending?: boolean;
  blockedReason?: string | null;
}) {
  return (
    <div className="space-y-3 border-t pt-4">
      {blockedReason && (
        <p
          id="wizard-blocked"
          role="status"
          aria-live="polite"
          className="text-muted-foreground text-right text-xs"
        >
          {blockedReason}
        </p>
      )}
      <div className="flex items-center justify-between gap-3">
        {onBack ? (
          <Button type="button" variant="outline" size="lg" onClick={onBack} disabled={pending}>
            <ArrowLeft />
            Back
          </Button>
        ) : (
          <span />
        )}
        <Button
          type="button"
          size="lg"
          onClick={onPrimary}
          disabled={primaryDisabled || pending}
          aria-describedby={blockedReason ? "wizard-blocked" : undefined}
        >
          {pending && <Loader2 className="animate-spin" />}
          {primaryLabel}
          {!pending && (primaryIcon ?? <ChevronRight />)}
        </Button>
      </div>
    </div>
  );
}
