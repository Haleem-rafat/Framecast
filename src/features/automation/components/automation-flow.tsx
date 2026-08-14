"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { FormField } from "@/components/shared/form-field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { startAutomationAction } from "@/actions/automation.action";
import type {
  AutomationField,
  AutomationProject,
  AutomationPromptSummary,
} from "@/services/automation.service";

/**
 * Words a narrator gets through in a minute, used only to turn the length
 * answer into something concrete ("about 1,200 words"). 150 is the middle of
 * the range an explainer voice actually lands in — the number exists to give
 * the operator a sense of scale, not to predict the render, so it is
 * deliberately presented as an approximation everywhere it appears.
 */
const WORDS_PER_MINUTE = 150;

/** Same floor `startAutomationSchema` enforces, repeated here only so the Next
 * button can refuse before a round trip rather than after one. */
const MIN_TOPIC_LENGTH = 3;

type StepKey = "topic" | "project" | "direction" | "length" | "review";

/**
 * The heart of "keep it genuinely short": a step exists only when it has a
 * question that cannot be answered without the operator.
 *
 * - **project** disappears for an operator with one project. There is nothing
 *   to choose, and a dropdown with one option is a click that teaches nothing.
 *   The review step still names the project that was picked, so an inferred
 *   answer is still a visible answer.
 * - **direction** disappears when the operator's prompt declares no variables
 *   beyond topic and duration — a prompt that hard-codes its own tone has
 *   nothing to ask about.
 * - **length** disappears when the prompt declares no `duration` variable,
 *   because a length typed into a prompt that cannot use it is a number thrown
 *   away.
 *
 * All three are properties of the operator's own data, so two operators
 * legitimately see different numbers of steps.
 */
function planSteps(
  projects: AutomationProject[],
  prompt: AutomationPromptSummary,
): StepKey[] {
  const steps: StepKey[] = ["topic"];

  if (projects.length > 1) steps.push("project");
  if (prompt.fields.length > 0) steps.push("direction");
  if (prompt.duration) steps.push("length");

  steps.push("review");

  return steps;
}

const STEP_TITLES: Record<StepKey, string> = {
  topic: "What is the video about?",
  project: "Which channel does it belong to?",
  direction: "How should it be written?",
  length: "How long should it be?",
  review: "Ready to generate",
};

/** One question from the operator's own prompt template. `defaultValue` is
 * shown as the placeholder rather than pre-filled into the field: leaving it
 * empty is what makes `renderTemplate` fall back to the template's own
 * default, and pre-filling would turn every default into a value the operator
 * appears to have chosen. */
function VariableField({
  field,
  value,
  onChange,
}: {
  field: AutomationField;
  value: string;
  onChange: (next: string) => void;
}) {
  const isRequired = field.required && !field.defaultValue;

  return (
    <FormField
      name={`variable-${field.key}`}
      label={
        <>
          {field.label}
          {isRequired && (
            <>
              {/* The asterisk was the only signal that an answer was
               * mandatory, and an asterisk is a glyph with no accessible name
               * — a screen reader read the label and stopped. The mark stays
               * for sighted operators, hidden from the tree, with the word it
               * stands for beside it. */}
              <span aria-hidden="true" className="text-destructive">
                *
              </span>
              <span className="sr-only">(required)</span>
            </>
          )}
        </>
      }
      description={
        field.defaultValue && !value.trim() ? (
          <>
            Leave this blank to use your prompt&apos;s default:{" "}
            <span className="font-medium">{field.defaultValue}</span>
          </>
        ) : undefined
      }
    >
      {(control) => (
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.defaultValue ?? ""}
          aria-required={isRequired || undefined}
          {...control}
        />
      )}
    </FormField>
  );
}

/**
 * The length question. Its own component rather than inline JSX so the
 * `duration` field is a plain, non-nullable prop — the alternative is a
 * non-null assertion inside the change handler, since narrowing
 * `prompt.duration` in the parent's JSX does not survive into a closure.
 */
function DurationField({
  field,
  value,
  estimatedWords,
  onChange,
}: {
  field: AutomationField;
  value: string;
  /** Null when the current value isn't a number — see the input's comment. */
  estimatedWords: number | null;
  onChange: (next: string) => void;
}) {
  return (
    <FormField
      name="duration"
      label={field.label}
      description={
        <>
          {estimatedWords === null
            ? ""
            : `Roughly ${estimatedWords.toLocaleString()} words of narration. `}
          Length is what everything downstream costs: a longer script is a
          longer Anthropic call, more ElevenLabs characters, more footage to
          fetch and a longer render. A short video finishes in minutes; a long
          one takes considerably longer.
        </>
      }
    >
      {/* Not `type="number"`: this is whatever the operator declared as a
          prompt variable, and its default is a free-text string. A numeric
          input would silently reject a perfectly valid non-numeric default.
          `inputMode` still gets a phone keyboard the right way round, and the
          estimate above simply doesn't render when the value isn't a number. */}
      {(control) => (
        <Input
          inputMode="numeric"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.defaultValue ?? "8"}
          {...control}
        />
      )}
    </FormField>
  );
}

export function AutomationFlow({
  projects,
  prompt,
}: {
  projects: AutomationProject[];
  prompt: AutomationPromptSummary;
}) {
  const router = useRouter();
  const steps = useMemo(() => planSteps(projects, prompt), [projects, prompt]);

  const [stepIndex, setStepIndex] = useState(0);
  const [topic, setTopic] = useState("");
  // Pre-selected rather than left empty. When there is exactly one project
  // this is the inference the flow reports on the review step; when there are
  // several it is a sensible starting point (projects are listed most-recently
  // updated first) that the project step lets the operator change.
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();

  /**
   * The client half of the double-submit guard.
   *
   * `isPending` already disables the button, and `AutomationService` refuses a
   * duplicate server-side (which is the guard that actually matters, since a
   * server action is reachable without this UI). This ref covers the gap those
   * two leave: the window between the click handler firing and React
   * committing the pending state, during which a second click — or a key
   * repeat on a focused button — would call the action again. A ref, not
   * state, precisely because it must be true *immediately* rather than on the
   * next render.
   *
   * Cleared only on failure. A success leaves it set, and navigates away from
   * this form to the run's own URL anyway.
   */
  const submitted = useRef(false);

  const step = steps[stepIndex];
  const selectedProject = projects.find((project) => project.id === projectId) ?? null;
  const durationKey = prompt.duration?.key ?? "";
  const durationValue = prompt.duration ? (variables[durationKey] ?? "") : "";
  const durationMinutes = Number.parseFloat(
    durationValue.trim() || (prompt.duration?.defaultValue ?? ""),
  );
  const hasDurationEstimate = Number.isFinite(durationMinutes) && durationMinutes > 0;

  function setVariable(key: string, value: string): void {
    setVariables((current) => ({ ...current, [key]: value }));
  }

  /** Which required answers this step is still missing. Empty means the
   * operator can move on. */
  function blockedReason(): string | null {
    if (step === "topic" && topic.trim().length < MIN_TOPIC_LENGTH) {
      return "Give the topic a few more words.";
    }

    if (step === "project" && !projectId) {
      return "Pick a project.";
    }

    if (step === "direction") {
      // Only variables with no default of their own can actually block: a
      // required variable that declares a default is always satisfiable, and
      // renderTemplate fills it in server-side.
      const missing = prompt.fields.filter(
        (field) =>
          field.required && !field.defaultValue && !(variables[field.key] ?? "").trim(),
      );

      if (missing.length > 0) {
        return `Your prompt needs: ${missing.map((field) => field.label).join(", ")}.`;
      }
    }

    // Same rule as the direction fields. Unusual — a `duration` variable
    // almost always declares a default — but a template can mark it required
    // with none, and the server would then refuse the submission after the
    // operator had answered every other question.
    if (
      step === "length" &&
      prompt.duration?.required &&
      !prompt.duration.defaultValue &&
      !durationValue.trim()
    ) {
      return `Your prompt needs: ${prompt.duration.label}.`;
    }

    return null;
  }

  const blocked = blockedReason();

  function onSubmit(event: React.FormEvent): void {
    event.preventDefault();

    if (blocked) return;

    if (step !== "review") {
      setStepIndex((current) => Math.min(current + 1, steps.length - 1));
      return;
    }

    if (submitted.current || isPending) return;
    submitted.current = true;

    startTransition(async () => {
      const response = await startAutomationAction({
        projectId,
        topic: topic.trim(),
        variables,
      });

      if (!response.ok) {
        submitted.current = false;
        toast.error("Could not generate that video", {
          description: response.error.message,
        });
        return;
      }

      toast.success("Script written, approved and queued", {
        description: `${response.data.wordCount} words. The render starts as soon as a worker picks it up.`,
      });

      // The run's progress lives at its own URL rather than in this
      // component's state, and this is the handoff. A render takes minutes on
      // a separate worker, so the one thing an operator will certainly do is
      // close the tab — `replace` puts the answer to "what is happening to my
      // video" somewhere that survives that, and re-reads it from the server
      // on the way back. It also means the browser's Back button does not
      // return to a filled-in form whose submission already happened.
      router.replace(`/automation?video=${response.data.videoId}`);
    });
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <div className="space-y-2">
        <div className="text-muted-foreground flex items-center justify-between text-xs">
          <span>
            Step {stepIndex + 1} of {steps.length}
          </span>
          <span>Using your &ldquo;{prompt.name}&rdquo; prompt</span>
        </div>
        <Progress value={((stepIndex + 1) / steps.length) * 100} className="h-1.5" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{STEP_TITLES[step]}</CardTitle>
          <CardDescription>
            {step === "topic" &&
              "One or two sentences. This becomes the video's topic and the {{topic}} variable in your script prompt."}
            {step === "project" &&
              "Projects group videos and carry the channel a finished video would publish to."}
            {step === "direction" &&
              "These are the variables your own script prompt declares. Edit the prompt and these questions change with it."}
            {step === "length" &&
              "Your prompt asks the model for a target length in minutes."}
            {step === "review" &&
              "One click writes the script, approves it for you, and queues the render."}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {step === "topic" && (
            <FormField
              name="topic"
              label="Topic"
              description={`${topic.trim().length}/300 characters`}
            >
              {(control) => (
                <Textarea
                  rows={4}
                  value={topic}
                  onChange={(event) => setTopic(event.target.value)}
                  placeholder="How index funds quietly took over the stock market"
                  maxLength={300}
                  autoFocus
                  {...control}
                />
              )}
            </FormField>
          )}

          {step === "project" && (
            <FormField name="projectId" label="Project">
              {(control) => (
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger {...control} className="w-full">
                    <SelectValue placeholder="Select a project" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                        {project.channelTitle
                          ? ` — ${project.channelTitle}`
                          : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
          )}

          {step === "direction" &&
            prompt.fields.map((field) => (
              <VariableField
                key={field.key}
                field={field}
                value={variables[field.key] ?? ""}
                onChange={(next) => setVariable(field.key, next)}
              />
            ))}

          {step === "length" && prompt.duration && (
            <DurationField
              field={prompt.duration}
              value={durationValue}
              estimatedWords={
                hasDurationEstimate
                  ? Math.round(durationMinutes * WORDS_PER_MINUTE)
                  : null
              }
              onChange={(next) => setVariable(durationKey, next)}
            />
          )}

          {step === "review" && (
            <dl className="divide-border divide-y text-sm">
              <div className="grid gap-1 py-3 sm:grid-cols-3">
                <dt className="text-muted-foreground">Topic</dt>
                <dd className="sm:col-span-2">{topic.trim()}</dd>
              </div>

              <div className="grid gap-1 py-3 sm:grid-cols-3">
                <dt className="text-muted-foreground">Project</dt>
                <dd className="space-y-0.5 sm:col-span-2">
                  <p>{selectedProject?.name ?? "—"}</p>
                  {/* An inferred answer still has to be a visible one. */}
                  {projects.length === 1 && (
                    <p className="text-muted-foreground text-xs">
                      Your only project, so it was picked for you.
                    </p>
                  )}
                  {selectedProject?.channelTitle && (
                    <p className="text-muted-foreground text-xs">
                      Would publish to {selectedProject.channelTitle} — but only
                      when you say so.
                    </p>
                  )}
                </dd>
              </div>

              {prompt.fields.map((field) => (
                <div key={field.key} className="grid gap-1 py-3 sm:grid-cols-3">
                  <dt className="text-muted-foreground">{field.label}</dt>
                  <dd className="sm:col-span-2">
                    {(variables[field.key] ?? "").trim() || (
                      <span className="text-muted-foreground">
                        {field.defaultValue
                          ? `${field.defaultValue} (your prompt's default)`
                          : "—"}
                      </span>
                    )}
                  </dd>
                </div>
              ))}

              {prompt.duration && (
                <div className="grid gap-1 py-3 sm:grid-cols-3">
                  <dt className="text-muted-foreground">{prompt.duration.label}</dt>
                  <dd className="sm:col-span-2">
                    {durationValue.trim() ||
                      `${prompt.duration.defaultValue ?? "—"} (your prompt's default)`}
                  </dd>
                </div>
              )}

              <div className="py-3">
                {/* Said before the click, not only after it. The operator is
                    about to spend money and skip a review step they would
                    otherwise perform by hand; both halves of that bargain
                    belong here. */}
                <p className="text-muted-foreground text-xs">
                  Framecast will write the script with your &ldquo;{prompt.name}
                  &rdquo; prompt, approve it on your behalf so the render can
                  start immediately, then run narration, footage and the render.
                  You can read the script as soon as it exists.{" "}
                  <span className="text-foreground font-medium">
                    Nothing is published to YouTube — that stays a separate,
                    deliberate click.
                  </span>
                </p>
              </div>
            </dl>
          )}
        </CardContent>

        <CardFooter className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setStepIndex((current) => Math.max(current - 1, 0))}
            disabled={stepIndex === 0 || isPending}
          >
            <ArrowLeft />
            Back
          </Button>

          <div className="flex items-center gap-3">
            {/* Deliberately *not* `FieldError`. This says why the disabled
             * button is disabled, and it is on screen from the moment a step
             * opens — before the operator has done anything wrong. Painting
             * "Give the topic a few more words" destructive-red on arrival
             * would accuse them of a mistake they have not made yet. It is
             * announced instead of coloured: `aria-live` speaks it when it
             * changes, and the button points at it so anyone landing on a
             * disabled button hears the reason. */}
            {blocked && (
              <p
                id="automation-blocked"
                role="status"
                aria-live="polite"
                className="text-muted-foreground text-xs"
              >
                {blocked}
              </p>
            )}
            <Button
              type="submit"
              disabled={Boolean(blocked) || isPending}
              aria-describedby={blocked ? "automation-blocked" : undefined}
            >
              {isPending ? (
                <Loader2 className="animate-spin" />
              ) : step === "review" ? (
                <Sparkles />
              ) : (
                <ArrowRight />
              )}
              {step === "review" ? "Generate video" : "Next"}
            </Button>
          </div>
        </CardFooter>
      </Card>

      {isPending && (
        <p className="text-muted-foreground text-center text-xs">
          Writing the script. This takes a few seconds and costs one Anthropic
          call — leave this page open until it lands.
        </p>
      )}
    </form>
  );
}
