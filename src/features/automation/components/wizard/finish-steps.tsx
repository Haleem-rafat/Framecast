"use client";

import type { ReactNode } from "react";
import { CalendarClock } from "lucide-react";

import { FormField } from "@/components/shared/form-field";
import { ChoiceCard, ChoiceGroup } from "@/components/shared/wizard/choice-card";
import { ToggleRow } from "@/components/shared/wizard/toggle-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PublishVisibility } from "@/generated/prisma/enums";
import { artStyleLabel } from "@/lib/art-styles";
import { footageStyleLabel, stylePicksArtStyle } from "@/lib/footage-styles";
import {
  describeRecurrence,
  firstOccurrenceAfter,
  ordinal,
  WEEKDAY_NAMES,
  type Recurrence,
} from "@/lib/schedule-time";
import { VIDEO_FORMATS } from "@/lib/video-format";
import { cn } from "@/lib/utils";

import { findNichePreset } from "./niche-presets";
import type { StepProps } from "./show-steps";
import {
  displayedCaptionMode,
  parseTime,
  parseTopics,
  WIZARD_STEPS,
  type Frequency,
  type SeriesDraft,
  type WizardStepId,
} from "./series-wizard-state";

/** Days of the month a series can name. 29–31 are offered and clamp to the
 *  month's last day rather than being hidden — the preview shows exactly what
 *  that means for the next run. */
const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, index) => index + 1);

const FREQUENCIES: readonly { value: Frequency; title: string; description: string }[] = [
  { value: "DAILY", title: "Every day", description: "Seven episodes a week — a topic a day." },
  { value: "WEEKLY", title: "Every week", description: "One episode on the same weekday." },
  { value: "MONTHLY", title: "Every month", description: "One episode on the same date." },
];

function recurrenceOf(draft: SeriesDraft): Recurrence | null {
  const time = parseTime(draft.time);

  if (!draft.timeZone || !time) {
    return null;
  }

  return {
    frequency: draft.frequency,
    dayOfWeek: draft.frequency === "WEEKLY" ? draft.dayOfWeek : null,
    dayOfMonth: draft.frequency === "MONTHLY" ? draft.dayOfMonth : null,
    hour: time.hour,
    minute: time.minute,
    timeZone: draft.timeZone,
  };
}

function nextRun(recurrence: Recurrence | null): Date | null {
  if (!recurrence) {
    return null;
  }

  try {
    return firstOccurrenceAfter(recurrence, new Date());
  } catch {
    return null;
  }
}

/**
 * Step 8: when episodes are made.
 *
 * The time is the operator's wall clock in the zone they pick, not UTC, and it
 * stays that wall clock across daylight saving — the preview is computed with
 * the exact function the worker uses, which is the only way to check what a
 * monthly 31st does in February before February arrives.
 */
export function ScheduleStep({
  draft,
  update,
  headingId,
  timeZones,
}: StepProps & { timeZones: string[] }) {
  const preview = nextRun(recurrenceOf(draft));
  const topics = parseTopics(draft.topicText).length;
  const unit = draft.frequency === "DAILY" ? "day" : draft.frequency === "WEEKLY" ? "week" : "month";

  return (
    <div className="space-y-6">
      <ChoiceGroup
        name="frequency"
        value={draft.frequency}
        onChange={(value) => update((current) => ({ ...current, frequency: value as Frequency }))}
        labelledBy={headingId}
        className="sm:grid-cols-3"
      >
        {FREQUENCIES.map((option) => (
          <ChoiceCard
            key={option.value}
            value={option.value}
            title={option.title}
            description={option.description}
          />
        ))}
      </ChoiceGroup>

      {draft.frequency === "WEEKLY" && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">On</legend>
          {/* Seven compact chips rather than seven cards: at 375px a card per
              weekday would not fit on one row, and a weekday is a word, not a
              choice that needs explaining. Real radios, like the cards. */}
          <div className="grid grid-cols-7 gap-1.5">
            {WEEKDAY_NAMES.map((day, index) => (
              <label
                key={day}
                className={cn(
                  "focus-within:ring-ring/50 flex h-10 cursor-pointer items-center justify-center rounded-lg border text-xs font-medium transition-colors focus-within:ring-3",
                  draft.dayOfWeek === index
                    ? "border-primary bg-primary/10 text-primary"
                    : "hover:border-muted-foreground/40",
                )}
              >
                <input
                  type="radio"
                  name="day-of-week"
                  value={index}
                  checked={draft.dayOfWeek === index}
                  onChange={() => update((current) => ({ ...current, dayOfWeek: index }))}
                  className="sr-only"
                />
                <span aria-hidden="true">{day.slice(0, 3)}</span>
                <span className="sr-only">{day}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {draft.frequency === "MONTHLY" && (
          <FormField
            name="dayOfMonth"
            label="On the"
            description={
              draft.dayOfMonth > 28 ? "Months without this day fall back to their last day." : undefined
            }
          >
            {(control) => (
              <Select
                value={String(draft.dayOfMonth)}
                onValueChange={(value) =>
                  update((current) => ({ ...current, dayOfMonth: Number(value) }))
                }
              >
                <SelectTrigger {...control} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
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
              value={draft.time}
              onChange={(event) => update((current) => ({ ...current, time: event.target.value }))}
              {...control}
            />
          )}
        </FormField>

        {/* A select, not cards: four hundred zones is the one list on this
            flow long enough that a menu is the better control. */}
        <FormField name="timeZone" label="Timezone">
          {(control) => (
            <Select
              value={draft.timeZone}
              onValueChange={(timeZone) => update((current) => ({ ...current, timeZone }))}
            >
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
        <p className="text-muted-foreground flex items-start gap-2 rounded-xl border px-4 py-3 text-sm">
          <CalendarClock className="mt-0.5 size-4 shrink-0" />
          <span>
            First scheduled episode{" "}
            <span className="text-foreground font-medium" suppressHydrationWarning>
              {preview.toLocaleString()}
            </span>{" "}
            in your browser&apos;s time. {topics} topic{topics === 1 ? "" : "s"} will last
            about {topics} {unit}
            {topics === 1 ? "" : "s"}.
          </span>
        </p>
      )}
    </div>
  );
}

const VISIBILITIES: readonly { value: PublishVisibility; title: string; description: string }[] = [
  { value: "PRIVATE", title: "Private", description: "Only you. The safe choice while a new show settles." },
  { value: "UNLISTED", title: "Unlisted", description: "Anyone with the link; not in search or on the channel." },
  { value: "PUBLIC", title: "Public", description: "Everyone, straight away." },
];

function SummaryRow({
  label,
  value,
  channelSetting,
  changed,
  onEdit,
}: {
  label: string;
  value: ReactNode;
  channelSetting?: boolean;
  changed?: boolean;
  onEdit: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0 space-y-0.5">
        <p className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
          {label}
          {channelSetting && (
            <Badge variant={changed ? "default" : "outline"} className="font-normal">
              {changed ? "Changes the channel" : "Channel setting"}
            </Badge>
          )}
        </p>
        <p className="text-sm font-medium break-words">{value}</p>
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={onEdit}>
        Edit
      </Button>
    </div>
  );
}

/**
 * Step 9: whether episodes publish themselves, and everything else read back
 * once before anything is written.
 */
export function ReviewStep({
  draft,
  update,
  context,
  channelTitle,
  changes,
  onEdit,
  outcome,
}: StepProps & {
  channelTitle: string;
  /** Which channel settings Create will also write — see `brandChanges`. */
  changes: string[];
  onEdit: (step: WizardStepId) => void;
  /** What the last Create attempt did, when it did not finish. */
  outcome: ReactNode;
}) {
  const style = context.setup.scriptStyles.find((entry) => entry.id === draft.promptTemplateId);
  const project = context.setup.projects.find((entry) => entry.id === draft.projectId);
  const preset = findNichePreset(draft.nichePresetId);
  const recurrence = recurrenceOf(draft);
  const topics = parseTopics(draft.topicText).length;
  const brand = draft.brand;
  const caption = displayedCaptionMode(draft, context);
  const label = (id: WizardStepId) => WIZARD_STEPS.find((step) => step.id === id)!.label;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <ToggleRow
          title="Publish each episode automatically"
          description={`An episode uploads itself to ${channelTitle} as soon as it has finished rendering, with nobody present. Off means it waits in your videos list until you publish it yourself.`}
          checked={draft.autoPublish}
          onCheckedChange={(autoPublish) => update((current) => ({ ...current, autoPublish }))}
        >
          <ChoiceGroup
            name="visibility"
            value={draft.publishVisibility}
            onChange={(value) =>
              update((current) => ({ ...current, publishVisibility: value as PublishVisibility }))
            }
            label="Publish as"
            className="sm:grid-cols-3"
          >
            {VISIBILITIES.map((option) => (
              <ChoiceCard
                key={option.value}
                value={option.value}
                title={option.title}
                description={option.description}
              />
            ))}
          </ChoiceGroup>
          <p className="text-muted-foreground mt-3 text-xs">
            You can make a video public later, but nothing here can take a published
            one down.
          </p>
        </ToggleRow>

        <ToggleRow
          title="Cut Shorts from each episode"
          description="When an episode finishes, pick moments from it to become Shorts. Costs one model call per episode; a selection that fails leaves the episode itself untouched."
          checked={draft.autoShorts}
          onCheckedChange={(autoShorts) => update((current) => ({ ...current, autoShorts }))}
        />
      </div>

      <div className="divide-y rounded-xl border">
        <SummaryRow
          label={label("niche")}
          value={`${preset?.title ?? "Custom"} — written with “${style?.name ?? "?"}”`}
          onEdit={() => onEdit("niche")}
        />
        <SummaryRow
          label={label("topics")}
          value={`${draft.name.trim()} · ${topics} topic${topics === 1 ? "" : "s"}`}
          onEdit={() => onEdit("topics")}
        />
        <SummaryRow
          label={label("channel")}
          value={`${channelTitle} · ${project?.name ?? "?"} · ${VIDEO_FORMATS[draft.format].label}`}
          onEdit={() => onEdit("channel")}
        />
        {brand && (
          <>
            <SummaryRow
              label={label("voice")}
              value={brand.voiceId ? (brand.voiceName ?? brand.voiceId) : "Default voice"}
              channelSetting
              changed={changes.includes("voice")}
              onEdit={() => onEdit("voice")}
            />
            <SummaryRow
              label={label("music")}
              value={brand.musicQuery ? `“${brand.musicQuery}”` : "The default search"}
              channelSetting
              changed={changes.includes("music")}
              onEdit={() => onEdit("music")}
            />
            <SummaryRow
              label={label("look")}
              value={
                stylePicksArtStyle(brand.footageStyle)
                  ? `${footageStyleLabel(brand.footageStyle)} · ${artStyleLabel(brand.artStyle)}`
                  : footageStyleLabel(brand.footageStyle)
              }
              channelSetting
              changed={changes.includes("look")}
              onEdit={() => onEdit("look")}
            />
            <SummaryRow
              label={label("captions")}
              value={caption === "kinetic" ? "Word by word" : "Line at a time"}
              channelSetting
              changed={changes.includes("captions")}
              onEdit={() => onEdit("captions")}
            />
          </>
        )}
        <SummaryRow
          label={label("schedule")}
          value={recurrence ? describeRecurrence(recurrence) : "Not set"}
          onEdit={() => onEdit("schedule")}
        />
      </div>

      {/* Said before the click, not after: the operator should know exactly
          which of their answers land on the channel — and therefore on every
          other video it makes — before pressing Create. */}
      <p className="text-muted-foreground text-xs">
        {changes.length > 0 ? (
          <>
            Creating this also saves {channelTitle}&apos;s{" "}
            <span className="text-foreground font-medium">{changes.join(", ")}</span>{" "}
            first. Those apply to every video on the channel, not only this series.{" "}
          </>
        ) : (
          <>Nothing on {channelTitle} changes. </>
        )}
        Each episode writes and approves a script, then renders the video.{" "}
        <span className="text-foreground font-medium">
          {draft.autoPublish
            ? `Finished episodes upload to YouTube as ${draft.publishVisibility.toLowerCase()} videos by themselves — you switched that on above.`
            : "Nothing is ever published to YouTube automatically — that stays a deliberate click, every time."}
        </span>
      </p>

      {outcome}
    </div>
  );
}
