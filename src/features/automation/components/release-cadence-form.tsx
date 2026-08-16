"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Clock, Loader2, Plus, Save, X } from "lucide-react";
import { toast } from "sonner";

import {
  createReleaseCadenceAction,
  updateReleaseCadenceAction,
} from "@/actions/release.action";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatSlot, upcomingSlots } from "@/lib/release-time";
import { MAX_SLOTS, parseSlotList } from "@/schemas/release.schema";
import type { ReleaseCadenceDetail } from "@/services/release.service";

/** The times a new cadence starts with. Morning, afternoon and evening — the
 *  shape of the operator's own three-a-day case, and a sensible spread for
 *  anyone else, who can add or remove rows either way. */
const DEFAULT_SLOTS = ["08:00", "14:00", "20:00"];

/** How many upcoming releases the preview lists. Enough to show the pattern
 *  wrapping past midnight into the next day, which is the part of a set of
 *  times that is hard to picture from the times alone. */
const PREVIEW_COUNT = 4;

const VISIBILITY_LABELS = {
  PUBLIC: "Public — anyone can find it",
  UNLISTED: "Unlisted — only people with the link",
  PRIVATE: "Private — only you",
} as const;

export interface ReleaseChannelChoice {
  id: string;
  title: string;
}

interface ReleaseCadenceFormProps {
  /** Channels that do not already have a cadence. Empty in edit mode, where the
   *  channel is fixed — see `createReleaseCadenceSchema` for why a cadence
   *  cannot be moved between channels. */
  channels: ReleaseChannelChoice[];
  /** IANA zone names, resolved on the server so the list is identical for
   *  everyone rather than varying with the browser's ICU build. */
  timeZones: string[];
  /** Present when editing. Absent means this is a new cadence. */
  cadence?: ReleaseCadenceDetail;
}

export function ReleaseCadenceForm({
  channels,
  timeZones,
  cadence,
}: ReleaseCadenceFormProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [channelId, setChannelId] = useState(
    cadence?.channelId ?? channels[0]?.id ?? "",
  );
  const [slots, setSlots] = useState<string[]>(
    cadence ? cadence.slotMinutes.map(formatSlot) : DEFAULT_SLOTS,
  );
  const [visibility, setVisibility] = useState<"PUBLIC" | "UNLISTED" | "PRIVATE">(
    cadence?.visibility ?? "PUBLIC",
  );

  /**
   * Left empty on the first render and filled in after mount, exactly as
   * `ScheduleForm` does it. The right default is the operator's own zone and
   * only the browser knows it; reading it during render would produce different
   * markup on the server and the client.
   */
  const [timeZone, setTimeZone] = useState(cadence?.timeZone ?? "");

  useEffect(() => {
    setTimeZone((current) => {
      if (current) {
        return current;
      }

      const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;

      return timeZones.includes(detected) ? detected : "UTC";
    });
  }, [timeZones]);

  /** The times as the server will see them, or null while any of them is not a
   *  time of day. The same `parseSlot` the schema uses, so the button's enabled
   *  state and the server's acceptance cannot disagree. */
  const slotMinutes = useMemo(() => parseSlotList(slots), [slots]);

  const duplicated = useMemo(
    () => slotMinutes !== null && new Set(slotMinutes).size !== slotMinutes.length,
    [slotMinutes],
  );

  /**
   * A live preview of the next few releases, computed with the exact same
   * function the worker uses.
   *
   * This is the only way an operator can see what a set of times *means*
   * without waiting a day for it. It answers the two things the form itself
   * cannot: that the zone they picked resolves to the clock they meant, and
   * that the pattern wraps into tomorrow where they expect it to.
   */
  const preview = useMemo(() => {
    if (!timeZone || slotMinutes === null || slotMinutes.length === 0 || duplicated) {
      return [];
    }

    try {
      const recurrence = { slotMinutes, timeZone };
      const now = new Date();

      return [
        ...upcomingSlots(recurrence, now, PREVIEW_COUNT),
      ];
    } catch {
      return [];
    }
  }, [slotMinutes, timeZone, duplicated]);

  const blocked =
    !channelId
      ? "Pick a channel."
      : slots.length === 0
        ? "Add at least one release time."
        : slotMinutes === null
          ? "One of those release times is not a valid time of day."
          : duplicated
            ? "Two of those release times are the same."
            : !timeZone
              ? "Pick a timezone."
              : null;

  function setSlotAt(index: number, value: string): void {
    setSlots((current) => current.map((slot, at) => (at === index ? value : slot)));
  }

  function addSlot(): void {
    setSlots((current) => [...current, "12:00"]);
  }

  function removeSlot(index: number): void {
    setSlots((current) => current.filter((_, at) => at !== index));
  }

  function onSubmit(event: React.FormEvent): void {
    event.preventDefault();

    if (blocked || isPending || slotMinutes === null) {
      return;
    }

    const payload = { slotMinutes, timeZone, visibility };

    startTransition(async () => {
      // The two branches are kept apart rather than unified behind one
      // `response` because they return different payloads — the create action
      // hands back the new id this navigates to, the update action has nothing
      // to hand back.
      if (cadence) {
        const response = await updateReleaseCadenceAction(cadence.id, payload);

        if (!response.ok) {
          toast.error("Could not save that cadence", {
            description: response.error.message,
          });
          return;
        }

        toast.success("Cadence saved");
        router.push(`/automation/releases/${cadence.id}`);
        router.refresh();
        return;
      }

      const response = await createReleaseCadenceAction({ ...payload, channelId });

      if (!response.ok) {
        toast.error("Could not set up that cadence", {
          description: response.error.message,
        });
        return;
      }

      toast.success("Shorts drip set up", {
        description:
          "The first clip goes out at the next slot, not now. If nothing is banked yet, the slot is recorded as skipped and the drip starts by itself when shorts are ready.",
      });
      router.push(`/automation/releases/${response.data.id}`);
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>When clips go out</CardTitle>
          <CardDescription>
            The times are your local times, in the zone you choose — not UTC.
            They stay your local times across daylight saving, so an 08:00 slot
            is still 08:00 in March.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {!cadence && (
            <FormField
              name="channelId"
              label="Channel"
              description="Clips are drawn from shorts cut from this channel's own videos, and go out with its branding. Each channel has one drip of its own."
            >
              {(control) => (
                <Select value={channelId} onValueChange={setChannelId}>
                  <SelectTrigger {...control} className="w-full">
                    <SelectValue placeholder="Select a channel" />
                  </SelectTrigger>
                  <SelectContent>
                    {channels.map((channel) => (
                      <SelectItem key={channel.id} value={channel.id}>
                        {channel.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
          )}

          <FormField
            name="slots"
            label="Release times"
            description={`${slots.length} a day — about ${slots.length * 7} clips a week. Three long videos a week yield roughly twenty-one shorts, which is what three a day spends.`}
          >
            {() => (
              <div className="space-y-2">
                {slots.map((slot, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <Input
                      type="time"
                      value={slot}
                      aria-label={`Release time ${index + 1}`}
                      onChange={(event) => setSlotAt(index, event.target.value)}
                      className="w-40"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeSlot(index)}
                      disabled={slots.length === 1}
                      aria-label={`Remove release time ${index + 1}`}
                    >
                      <X />
                    </Button>
                  </div>
                ))}

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addSlot}
                  disabled={slots.length >= MAX_SLOTS}
                >
                  <Plus />
                  Add a time
                </Button>
              </div>
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

          <FormField
            name="visibility"
            label="Visibility"
            description="Every clip this drip publishes goes out this way. Set it to private for a day if you would rather watch the timing work before anything is visible."
          >
            {(control) => (
              <Select
                value={visibility}
                onValueChange={(next) =>
                  setVisibility(next as "PUBLIC" | "UNLISTED" | "PRIVATE")
                }
              >
                <SelectTrigger {...control} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(VISIBILITY_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>

          {preview.length > 0 && (
            <div className="text-muted-foreground space-y-1 text-sm">
              <p className="flex items-center gap-2">
                <Clock className="size-4 shrink-0" />
                <span>
                  The next {preview.length} releases would be, in your
                  browser&apos;s time:
                </span>
              </p>
              <ul className="ml-6 list-disc">
                {preview.map((slot) => (
                  <li key={slot.toISOString()}>
                    <span
                      className="text-foreground font-medium"
                      suppressHydrationWarning
                    >
                      {slot.toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardFooter className="flex flex-col items-stretch gap-2 py-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-muted-foreground text-xs">
            This drip only <span className="text-foreground font-medium">releases</span>{" "}
            shorts that already exist — it never generates one, and it never
            costs a provider call. Clips are cut when you generate shorts on a
            finished video.
          </p>

          <div className="flex items-center gap-3">
            {blocked && (
              <p
                id="cadence-blocked"
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
              aria-describedby={blocked ? "cadence-blocked" : undefined}
            >
              {isPending ? <Loader2 className="animate-spin" /> : <Save />}
              {cadence ? "Save changes" : "Start the drip"}
            </Button>
          </div>
        </CardFooter>
      </Card>
    </form>
  );
}
