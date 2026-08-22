"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Loader2, Save } from "lucide-react";
import { toast } from "sonner";

import { createScheduleAction, updateScheduleAction } from "@/actions/schedule.action";
import { FormField } from "@/components/shared/form-field";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  firstOccurrenceAfter,
  ordinal,
  WEEKDAY_NAMES,
  type Recurrence,
} from "@/lib/schedule-time";
import type {
  AutomationField,
  AutomationProject,
  AutomationPromptSummary,
} from "@/services/automation.service";
import type { PublishVisibility } from "@/generated/prisma/enums";
import type { ScheduleDetail } from "@/services/schedule.service";

/** Days of the month a schedule can name. 29–31 are offered and clamp to the
 *  month's last day rather than being hidden — the preview below shows exactly
 *  what that means for the next run, which is a better explanation than a
 *  missing option. */
const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, index) => index + 1);

interface ScheduleFormProps {
  projects: AutomationProject[];
  prompt: AutomationPromptSummary;
  /** IANA zone names, resolved on the server so the list is identical for
   *  everyone rather than varying with the browser's ICU build. */
  timeZones: string[];
  /** Present when editing. Absent means this is a new schedule, which is also
   *  the only mode that seeds the topic queue. */
  schedule?: ScheduleDetail;
}

/** One prompt-variable answer. The same rule the guided flow uses: a template
 *  default is shown as a placeholder, never pre-filled, because leaving the box
 *  empty is what makes `renderTemplate` fall back to it. */
function VariableAnswer({
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
              <span aria-hidden="true" className="text-destructive">
                *
              </span>
              <span className="sr-only">(required)</span>
            </>
          )}
        </>
      }
      description={
        field.defaultValue && !value.trim()
          ? `Leave blank to use your prompt's default: ${field.defaultValue}`
          : undefined
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

export function ScheduleForm({
  projects,
  prompt,
  timeZones,
  schedule,
}: ScheduleFormProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [name, setName] = useState(schedule?.name ?? "");
  const [projectId, setProjectId] = useState(
    schedule?.projectId ?? projects[0]?.id ?? "",
  );
  const [frequency, setFrequency] = useState<"DAILY" | "WEEKLY" | "MONTHLY">(
    schedule?.frequency ?? "WEEKLY",
  );
  const [dayOfWeek, setDayOfWeek] = useState(String(schedule?.dayOfWeek ?? 1));
  const [dayOfMonth, setDayOfMonth] = useState(String(schedule?.dayOfMonth ?? 1));
  const [time, setTime] = useState(
    `${String(schedule?.hour ?? 9).padStart(2, "0")}:${String(
      schedule?.minute ?? 0,
    ).padStart(2, "0")}`,
  );
  const [variables, setVariables] = useState<Record<string, string>>(
    schedule?.variables ?? {},
  );
  // Off for a new schedule — see `Schedule.autoPublish` in schema.prisma for
  // why that default is the important half.
  const [autoPublish, setAutoPublish] = useState(schedule?.autoPublish ?? false);
  const [publishVisibility, setPublishVisibility] = useState<PublishVisibility>(
    schedule?.publishVisibility ?? "PRIVATE",
  );
  const [topicText, setTopicText] = useState("");

  /**
   * Left empty on the first render and filled in after mount.
   *
   * The right default is the operator's own zone, and only the browser knows
   * it. Reading it during render would produce different markup on the server
   * (which has no idea) and the client, which is a hydration mismatch — so the
   * select shows its placeholder for one frame instead.
   */
  const [timeZone, setTimeZone] = useState(schedule?.timeZone ?? "");

  useEffect(() => {
    setTimeZone((current) => {
      if (current) {
        return current;
      }

      const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;

      return timeZones.includes(detected) ? detected : "UTC";
    });
  }, [timeZones]);

  const [hour, minute] = useMemo(() => {
    const [rawHour, rawMinute] = time.split(":");

    return [Number(rawHour), Number(rawMinute)];
  }, [time]);

  const recurrence: Recurrence | null = useMemo(() => {
    if (!timeZone || !Number.isFinite(hour) || !Number.isFinite(minute)) {
      return null;
    }

    return {
      frequency,
      dayOfWeek: frequency === "WEEKLY" ? Number(dayOfWeek) : null,
      dayOfMonth: frequency === "MONTHLY" ? Number(dayOfMonth) : null,
      hour,
      minute,
      timeZone,
    };
  }, [frequency, dayOfWeek, dayOfMonth, hour, minute, timeZone]);

  /**
   * A live preview of the next run, computed with the exact same function the
   * worker uses.
   *
   * Worth the duplication of effort: the two things an operator cannot check by
   * reading the form back are what a monthly 31st does in February and what a
   * timezone actually resolves to. Showing the instant — in their own locale —
   * answers both before they save rather than a month later.
   */
  const preview = useMemo(() => {
    if (!recurrence) {
      return null;
    }

    try {
      return firstOccurrenceAfter(recurrence, new Date());
    } catch {
      return null;
    }
  }, [recurrence]);

  const topics = useMemo(
    () =>
      topicText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    [topicText],
  );

  const declared = prompt.duration ? [...prompt.fields, prompt.duration] : prompt.fields;

  const missingAnswers = declared.filter(
    (field) =>
      field.required && !field.defaultValue && !(variables[field.key] ?? "").trim(),
  );

  const blocked =
    name.trim().length === 0
      ? "Give the schedule a name."
      : !projectId
        ? "Pick a project."
        : !timeZone
          ? "Pick a timezone."
          : missingAnswers.length > 0
            ? `Your prompt needs: ${missingAnswers.map((field) => field.label).join(", ")}.`
            : !schedule && topics.length === 0
              ? "Write at least one topic — a schedule with an empty queue pauses itself on its first run."
              : null;

  function onSubmit(event: React.FormEvent): void {
    event.preventDefault();

    if (blocked || isPending || !recurrence) {
      return;
    }

    const payload = {
      name: name.trim(),
      projectId,
      frequency,
      dayOfWeek: recurrence.dayOfWeek,
      dayOfMonth: recurrence.dayOfMonth,
      hour,
      minute,
      timeZone,
      autoPublish,
      publishVisibility,
      variables,
    };

    startTransition(async () => {
      // The two branches are kept apart rather than unified behind one
      // `response` because they return different payloads — the create action
      // hands back the new id this navigates to, the update action has nothing
      // to hand back. Merging them would need a cast at the one place the id
      // actually matters.
      if (schedule) {
        const response = await updateScheduleAction(schedule.id, payload);

        if (!response.ok) {
          toast.error("Could not save that schedule", {
            description: response.error.message,
          });
          return;
        }

        toast.success("Schedule saved");
        router.push(`/automation/schedules/${schedule.id}`);
        router.refresh();
        return;
      }

      const response = await createScheduleAction({ ...payload, topics });

      if (!response.ok) {
        toast.error("Could not create that schedule", {
          description: response.error.message,
        });
        return;
      }

      toast.success("Schedule created", {
        description: `${topics.length} topic${topics.length === 1 ? "" : "s"} queued. The first run happens at the next occurrence, not now.`,
      });
      router.push(`/automation/schedules/${response.data.id}`);
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>When it runs</CardTitle>
          <CardDescription>
            The time is your local time, in the zone you choose — not UTC. It
            stays your local time across daylight saving, so a 09:00 schedule is
            still 09:00 in March.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <FormField
            name="name"
            label="Name"
            description="Just for you — it names the schedule in the list and in its history."
          >
            {(control) => (
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Weekly explainer"
                maxLength={80}
                {...control}
              />
            )}
          </FormField>

          <FormField
            name="projectId"
            label="Project"
            description="Every video this produces belongs to this project and inherits its channel."
          >
            {(control) => (
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger {...control} className="w-full">
                  <SelectValue placeholder="Select a project" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                      {project.channelTitle ? ` — ${project.channelTitle}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField name="frequency" label="How often">
              {(control) => (
                <Select
                  value={frequency}
                  onValueChange={(next) => setFrequency(next as "DAILY" | "WEEKLY" | "MONTHLY")}
                >
                  <SelectTrigger {...control} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="WEEKLY">Every week</SelectItem>
                    <SelectItem value="MONTHLY">Every month</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </FormField>

            {frequency === "WEEKLY" ? (
              <FormField name="dayOfWeek" label="On">
                {(control) => (
                  <Select value={dayOfWeek} onValueChange={setDayOfWeek}>
                    <SelectTrigger {...control} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WEEKDAY_NAMES.map((day, index) => (
                        <SelectItem key={day} value={String(index)}>
                          {day}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </FormField>
            ) : (
              <FormField
                name="dayOfMonth"
                label="On the"
                description={
                  Number(dayOfMonth) > 28
                    ? "Months without this day fall back to their last day."
                    : undefined
                }
              >
                {(control) => (
                  <Select value={dayOfMonth} onValueChange={setDayOfMonth}>
                    <SelectTrigger {...control} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DAYS_OF_MONTH.map((day) => (
                        <SelectItem key={day} value={String(day)}>
                          {ordinal(day)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </FormField>
            )}

            <FormField name="time" label="At">
              {(control) => (
                <Input
                  type="time"
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                  {...control}
                />
              )}
            </FormField>

            <FormField name="timeZone" label="Timezone">
              {(control) => (
                <Select value={timeZone} onValueChange={setTimeZone}>
                  <SelectTrigger {...control} className="w-full">
                    <SelectValue placeholder="Detecting…" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {timeZones.map((zone) => (
                      <SelectItem key={zone} value={zone}>
                        {zone}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
          </div>

          {preview && (
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
              <CalendarClock className="size-4 shrink-0" />
              <span>
                {schedule ? "Would next run" : "First run"}{" "}
                <span className="text-foreground font-medium" suppressHydrationWarning>
                  {preview.toLocaleString()}
                </span>{" "}
                in your browser&apos;s time.
              </span>
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Publishing</CardTitle>
          <CardDescription>
            Off means a video waits in your videos list until you publish it
            yourself, which is how every schedule worked before this setting
            existed.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="schedule-auto-publish" className="font-medium">
                Publish each video automatically
              </Label>
              <p className="text-muted-foreground text-xs">
                A video uploads itself to whichever channel this project
                publishes to, as soon as it has finished rendering, with nobody
                present.
              </p>
            </div>
            <Switch
              id="schedule-auto-publish"
              checked={autoPublish}
              onCheckedChange={setAutoPublish}
            />
          </div>

          {/* Revealed rather than always shown — see the identical card in
              series-form.tsx. Repeated rather than shared: nine lines of JSX
              inside two differently-laid-out forms, with wording that
              deliberately differs (a schedule makes videos, a series makes
              episodes). Worth extracting if a third caller appears. */}
          {autoPublish && (
            <FormField
              name="publishVisibility"
              label="Publish as"
              description="Private is the safe choice while you are getting a schedule right — you can make a video public later, but nothing here can take a published one down."
            >
              {(control) => (
                <Select
                  value={publishVisibility}
                  onValueChange={(value) =>
                    setPublishVisibility(value as PublishVisibility)
                  }
                >
                  <SelectTrigger {...control}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PRIVATE">Private</SelectItem>
                    <SelectItem value="UNLISTED">Unlisted</SelectItem>
                    <SelectItem value="PUBLIC">Public</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </FormField>
          )}
        </CardContent>
      </Card>

      {declared.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>How each video is written</CardTitle>
            <CardDescription>
              These are the variables your default &ldquo;{prompt.name}&rdquo;
              prompt declares. Every run uses the same answers — only the topic
              changes.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            {declared.map((field) => (
              <VariableAnswer
                key={field.key}
                field={field}
                value={variables[field.key] ?? ""}
                onChange={(next) =>
                  setVariables((current) => ({ ...current, [field.key]: next }))
                }
              />
            ))}
          </CardContent>
        </Card>
      )}

      {!schedule && (
        <Card>
          <CardHeader>
            <CardTitle>Topic queue</CardTitle>
            <CardDescription>
              One topic per line. Each run takes the next one down the list.
              Nothing here invents a subject for you — when the list runs out,
              the schedule pauses itself and tells you so.
            </CardDescription>
          </CardHeader>

          <CardContent>
            <FormField
              name="topics"
              label="Topics"
              description={`${topics.length} topic${topics.length === 1 ? "" : "s"} — ${
                topics.length === 0
                  ? "the schedule needs at least one"
                  : frequency === "WEEKLY"
                    ? `about ${topics.length} week${topics.length === 1 ? "" : "s"} of videos`
                    : `about ${topics.length} month${topics.length === 1 ? "" : "s"} of videos`
              }`}
            >
              {(control) => (
                <Textarea
                  rows={8}
                  value={topicText}
                  onChange={(event) => setTopicText(event.target.value)}
                  placeholder={
                    "How index funds quietly took over the stock market\n" +
                    "Why airlines overbook flights\n" +
                    "What a port actually does all day"
                  }
                  {...control}
                />
              )}
            </FormField>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardFooter className="flex flex-col items-stretch gap-2 py-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-muted-foreground text-xs">
            Each run writes and approves a script, then renders the video.{" "}
            <span className="text-foreground font-medium">
              Nothing is ever published to YouTube automatically — that stays a
              deliberate click, every time.
            </span>
          </p>

          <div className="flex items-center gap-3">
            {blocked && (
              <p
                id="schedule-blocked"
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
              aria-describedby={blocked ? "schedule-blocked" : undefined}
            >
              {isPending ? <Loader2 className="animate-spin" /> : <Save />}
              {schedule ? "Save changes" : "Create schedule"}
            </Button>
          </div>
        </CardFooter>
      </Card>
    </form>
  );
}
