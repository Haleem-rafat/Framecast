"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CalendarClock, Loader2, MonitorPlay, Save, Smartphone } from "lucide-react";
import { toast } from "sonner";

import { createSeriesAction, updateSeriesAction } from "@/actions/series.action";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { PublishVisibility, VideoFormat } from "@/generated/prisma/enums";
import {
  firstOccurrenceAfter,
  ordinal,
  WEEKDAY_NAMES,
  type Recurrence,
} from "@/lib/schedule-time";
import { VIDEO_FORMATS } from "@/lib/video-format";
import type { AutomationField } from "@/services/automation.service";
import type { SeriesDetail, SeriesSetup } from "@/services/series.service";

/** Days of the month a series can name. 29–31 are offered and clamp to the
 *  month's last day rather than being hidden — the preview below shows exactly
 *  what that means for the next run. Same list, same reasoning, as the schedule
 *  form. */
const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, index) => index + 1);

/** Landscape first, because it is what every video before formats existed was
 *  and what an operator who does not read the radio group will get. */
const FORMAT_ORDER: VideoFormat[] = ["LANDSCAPE", "VERTICAL"];

const FORMAT_ICON: Record<VideoFormat, typeof MonitorPlay> = {
  LANDSCAPE: MonitorPlay,
  VERTICAL: Smartphone,
};

/** One prompt-variable answer. The same rule the guided flow and the schedule
 *  form use: a template default is shown as a placeholder, never pre-filled,
 *  because leaving the box empty is what makes `renderTemplate` fall back to
 *  it. */
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
          ? `Leave blank to use the style's default: ${field.defaultValue}`
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

interface SeriesFormProps {
  setup: SeriesSetup;
  /** IANA zone names, resolved on the server so the list is identical for
   *  everyone rather than varying with the browser's ICU build. */
  timeZones: string[];
  /** Present when editing. Absent means this is a new series, which is also the
   *  only mode that seeds the topic queue. */
  series?: SeriesDetail;
}

/**
 * One form for the whole recipe.
 *
 * The point of the screen is that it is *one* screen. Before this existed the
 * same five answers lived on the branding page, the script panel, the approve
 * dialog and the schedule form, and a second show meant visiting all of them
 * and remembering which had which. So the order here is the order an operator
 * describes a show in: what it is called, whose channel it is on, how each
 * episode is written and shaped, how often, and what it is about.
 *
 * The channel card is the one that says what this form deliberately does *not*
 * do. A series cannot override the channel's look, voice, music or audience
 * declaration; it inherits them, and the card names them and links to the one
 * place they are edited. Showing the list rather than staying silent is the
 * difference between "these settings are elsewhere" and "these settings are
 * missing".
 */
export function SeriesForm({ setup, timeZones, series }: SeriesFormProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [name, setName] = useState(series?.name ?? "");
  const [channelId, setChannelId] = useState(
    series?.channelId ??
      // Default to a channel that actually has a project pointing at it —
      // anything else puts the form into its own "no project publishes here"
      // refusal on first paint.
      setup.channels.find((channel) =>
        setup.projects.some((project) => project.channelId === channel.id),
      )?.id ??
      "",
  );
  const [projectId, setProjectId] = useState(series?.projectId ?? "");
  const [promptTemplateId, setPromptTemplateId] = useState(
    series?.scriptStyleId ??
      setup.scriptStyles.find((style) => style.isDefault)?.id ??
      setup.scriptStyles[0]?.id ??
      "",
  );
  const [format, setFormat] = useState<VideoFormat>(series?.format ?? "LANDSCAPE");
  // Off for a new show, and that default is the point — see `Series.autoPublish`
  // in schema.prisma. An existing show opens on whatever it was set to.
  const [autoPublish, setAutoPublish] = useState(series?.autoPublish ?? false);
  const [publishVisibility, setPublishVisibility] = useState<PublishVisibility>(
    series?.publishVisibility ?? "PRIVATE",
  );
  const [frequency, setFrequency] = useState<"WEEKLY" | "MONTHLY">(
    series?.frequency ?? "WEEKLY",
  );
  const [dayOfWeek, setDayOfWeek] = useState(String(series?.dayOfWeek ?? 1));
  const [dayOfMonth, setDayOfMonth] = useState(String(series?.dayOfMonth ?? 1));
  const [time, setTime] = useState(
    `${String(series?.hour ?? 9).padStart(2, "0")}:${String(
      series?.minute ?? 0,
    ).padStart(2, "0")}`,
  );
  const [variables, setVariables] = useState<Record<string, string>>(
    series?.variables ?? {},
  );
  const [topicText, setTopicText] = useState("");

  /**
   * Left empty on the first render and filled in after mount, for the reason
   * the schedule form documents: only the browser knows the operator's zone,
   * and reading it during render is a hydration mismatch.
   */
  const [timeZone, setTimeZone] = useState(series?.timeZone ?? "");

  useEffect(() => {
    setTimeZone((current) => {
      if (current) {
        return current;
      }

      const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;

      return timeZones.includes(detected) ? detected : "UTC";
    });
  }, [timeZones]);

  const channel = setup.channels.find((entry) => entry.id === channelId) ?? null;

  /**
   * Only projects that publish to the chosen channel.
   *
   * Not cosmetic filtering: the renderer resolves a video's brand through
   * `video -> project -> channel`, so a series naming this channel while filing
   * into a project that publishes elsewhere would show one brand on screen and
   * use another in the render. The server refuses that pairing; the picker
   * simply never offers it.
   */
  const projects = useMemo(
    () => setup.projects.filter((project) => project.channelId === channelId),
    [setup.projects, channelId],
  );

  // A channel change can strand the selected project on another channel.
  useEffect(() => {
    setProjectId((current) =>
      projects.some((project) => project.id === current)
        ? current
        : (projects[0]?.id ?? ""),
    );
  }, [projects]);

  const style = setup.scriptStyles.find((entry) => entry.id === promptTemplateId) ?? null;

  const declared = useMemo(() => {
    if (!style) {
      return [];
    }

    return style.duration ? [...style.fields, style.duration] : style.fields;
  }, [style]);

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

  /** A live preview of the next run, computed with the exact function the
   *  worker uses — the only way an operator can check what a monthly 31st does
   *  in February before a month has passed. */
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

  const missingAnswers = declared.filter(
    (field) =>
      field.required && !field.defaultValue && !(variables[field.key] ?? "").trim(),
  );

  const blocked =
    name.trim().length === 0
      ? "Give the series a name."
      : !channelId
        ? "Pick a channel."
        : !projectId
          ? "Pick a project that publishes to this channel."
          : !promptTemplateId
            ? "Pick the script style that writes each episode."
            : !timeZone
              ? "Pick a timezone."
              : missingAnswers.length > 0
                ? `The script style needs: ${missingAnswers.map((field) => field.label).join(", ")}.`
                : !series && topics.length === 0
                  ? "Write at least one topic — nothing here invents a subject."
                  : null;

  function onSubmit(event: React.FormEvent): void {
    event.preventDefault();

    if (blocked || isPending || !recurrence) {
      return;
    }

    const payload = {
      name: name.trim(),
      channelId,
      projectId,
      promptTemplateId,
      format,
      autoPublish,
      publishVisibility,
      frequency,
      dayOfWeek: recurrence.dayOfWeek,
      dayOfMonth: recurrence.dayOfMonth,
      hour,
      minute,
      timeZone,
      variables,
    };

    startTransition(async () => {
      if (series) {
        const response = await updateSeriesAction(series.id, payload);

        if (!response.ok) {
          toast.error("Could not save that series", {
            description: response.error.message,
          });
          return;
        }

        toast.success("Series saved");
        router.push(`/automation/series/${series.id}`);
        router.refresh();
        return;
      }

      const response = await createSeriesAction({ ...payload, topics });

      if (!response.ok) {
        toast.error("Could not create that series", {
          description: response.error.message,
        });
        return;
      }

      toast.success("Series created", {
        description: `${topics.length} topic${topics.length === 1 ? "" : "s"} queued. The first scheduled episode is at the next occurrence, not now — or press "Make one now".`,
      });
      router.push(`/automation/series/${response.data.id}`);
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>What the show is</CardTitle>
          <CardDescription>
            Named once, and every episode inherits all of it. Nothing below is
            asked again per video.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <FormField
            name="name"
            label="Name"
            description="Just for you — it names the series in the list, in its history and on the videos it makes."
          >
            {(control) => (
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Money Mechanics — weekly explainer"
                maxLength={80}
                {...control}
              />
            )}
          </FormField>

          <FormField
            name="channelId"
            label="Channel"
            description="Where episodes are published, and where their look, voice, music and audience declaration come from."
          >
            {(control) => (
              <Select value={channelId} onValueChange={setChannelId}>
                <SelectTrigger {...control} className="w-full">
                  <SelectValue placeholder="Select a channel" />
                </SelectTrigger>
                <SelectContent>
                  {setup.channels.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>

          {/* The honest statement of what a series does not do. Two series on
              one channel share every one of these; the one that wins is always
              the channel's, and this says where to change it. */}
          {channel && (
            <p className="text-muted-foreground bg-muted/40 rounded-md border px-3 py-2 text-xs">
              This series inherits {channel.title}&apos;s niche, tone, voice,
              music, footage style, art style, character sheet, language,
              category and made-for-kids declaration.{" "}
              <span className="text-foreground font-medium">
                A series cannot override them
              </span>{" "}
              — every series on this channel looks and sounds the same, which is
              what makes it one channel.{" "}
              <Link
                href={`/channels/${channel.id}`}
                className="text-primary underline-offset-4 hover:underline"
              >
                Edit {channel.title}&apos;s branding
              </Link>
              .
            </p>
          )}

          <FormField
            name="projectId"
            label="Project"
            description="Where this show's videos are filed. Only projects that publish to the chosen channel are offered."
          >
            {(control) =>
              projects.length === 0 ? (
                <p className="text-muted-foreground rounded-md border border-dashed px-3 py-3 text-sm">
                  No project publishes to this channel yet.{" "}
                  <Link
                    href="/projects"
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    Point one at it
                  </Link>{" "}
                  and come back.
                </p>
              ) : (
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger {...control} className="w-full">
                    <SelectValue placeholder="Select a project" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )
            }
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How each episode is made</CardTitle>
          <CardDescription>
            The two answers that used to be given again on every single video —
            which prompt writes it, and what shape it comes out.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <FormField
            name="promptTemplateId"
            label="Script style"
            description="Any SCRIPT prompt in your library. Its own questions appear below."
          >
            {(control) => (
              <Select value={promptTemplateId} onValueChange={setPromptTemplateId}>
                <SelectTrigger {...control} className="w-full">
                  <SelectValue placeholder="Select a script style" />
                </SelectTrigger>
                <SelectContent>
                  {setup.scriptStyles.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.name}
                      {entry.isDefault ? " (your default)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Format</legend>
            <RadioGroup
              value={format}
              onValueChange={(next) => setFormat(next as VideoFormat)}
              className="gap-2"
            >
              {FORMAT_ORDER.map((option) => {
                const facts = VIDEO_FORMATS[option];
                const Icon = FORMAT_ICON[option];

                return (
                  <Label
                    key={option}
                    htmlFor={`series-format-${option}`}
                    className="hover:bg-accent/40 has-[:checked]:border-primary flex cursor-pointer items-start gap-3 rounded-md border p-3"
                  >
                    <RadioGroupItem
                      id={`series-format-${option}`}
                      value={option}
                      className="mt-0.5"
                    />
                    <span className="space-y-1">
                      <span className="flex items-center gap-2 font-medium">
                        <Icon className="size-4" />
                        {facts.label}
                        <span className="text-muted-foreground font-normal">
                          {facts.dimensions} · {facts.aspect}
                        </span>
                      </span>
                      <span className="text-muted-foreground block text-xs font-normal">
                        {facts.summary}
                      </span>
                    </span>
                  </Label>
                );
              })}
            </RadioGroup>
          </fieldset>

          {declared.length > 0 && (
            <div className="space-y-4 border-t pt-4">
              <p className="text-muted-foreground text-xs">
                These are the variables &ldquo;{style?.name}&rdquo; declares.
                Every episode uses the same answers — only the topic changes.
              </p>
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
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Publishing</CardTitle>
          <CardDescription>
            Off means an episode waits in your videos list until you publish it
            yourself, which is how every show worked before this setting
            existed.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="series-auto-publish" className="font-medium">
                Publish each episode automatically
              </Label>
              <p className="text-muted-foreground text-xs">
                An episode uploads itself to {channel?.title ?? "the channel"}{" "}
                as soon as it has finished rendering, with nobody present.
              </p>
            </div>
            <Switch
              id="series-auto-publish"
              checked={autoPublish}
              onCheckedChange={setAutoPublish}
            />
          </div>

          {/* Revealed rather than always shown. A choice about how public
              something is has no meaning for a show that is not publishing
              itself, and leaving it on screen invites somebody to set it and
              believe they have turned the feature on. */}
          {autoPublish && (
            <FormField
              name="publishVisibility"
              label="Publish as"
              description="Private is the safe choice while you are getting a new show right — you can make a video public later, but nothing here can take a published one down."
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

      <Card>
        <CardHeader>
          <CardTitle>How often</CardTitle>
          <CardDescription>
            The time is your local time, in the zone you choose — not UTC. It
            stays your local time across daylight saving, so a 09:00 series is
            still 09:00 in March.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField name="frequency" label="How often">
              {(control) => (
                <Select
                  value={frequency}
                  onValueChange={(next) => setFrequency(next as "WEEKLY" | "MONTHLY")}
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
                {series ? "Would next run" : "First scheduled episode"}{" "}
                <span className="text-foreground font-medium" suppressHydrationWarning>
                  {preview.toLocaleString()}
                </span>{" "}
                in your browser&apos;s time.
              </span>
            </p>
          )}
        </CardContent>
      </Card>

      {!series && (
        <Card>
          <CardHeader>
            <CardTitle>Topic queue</CardTitle>
            <CardDescription>
              One topic per line. Each episode takes the next one down the list.
              Nothing here invents a subject for you — when the list runs out,
              the series pauses itself and tells you so.
            </CardDescription>
          </CardHeader>

          <CardContent>
            <FormField
              name="topics"
              label="Topics"
              description={`${topics.length} topic${topics.length === 1 ? "" : "s"} — ${
                topics.length === 0
                  ? "a series needs at least one"
                  : frequency === "WEEKLY"
                    ? `about ${topics.length} week${topics.length === 1 ? "" : "s"} of episodes`
                    : `about ${topics.length} month${topics.length === 1 ? "" : "s"} of episodes`
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
            Each episode writes and approves a script, then renders the video.{" "}
            <span className="text-foreground font-medium">
              Nothing is ever published to YouTube automatically — that stays a
              deliberate click, every time.
            </span>
          </p>

          <div className="flex items-center gap-3">
            {blocked && (
              <p
                id="series-blocked"
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
              aria-describedby={blocked ? "series-blocked" : undefined}
            >
              {isPending ? <Loader2 className="animate-spin" /> : <Save />}
              {series ? "Save changes" : "Create series"}
            </Button>
          </div>
        </CardFooter>
      </Card>
    </form>
  );
}
