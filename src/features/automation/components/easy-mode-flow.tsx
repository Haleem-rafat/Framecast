"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, PenLine, Sparkles, Wand2 } from "lucide-react";
import { toast } from "sonner";

import { FormFieldset } from "@/components/shared/form-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import {
  startEasyVideoAction,
  suggestSubjectsAction,
} from "@/actions/easy-mode.action";
import type {
  EasyChannel,
  EasySubject,
  EasySubjectOrigin,
} from "@/services/easy-mode.service";

/**
 * Easy mode: a whole video from two taps.
 *
 * ## What this screen is for
 *
 * The written flow asks four questions and every one of them is a text box: a
 * topic to invent, a value per variable the script prompt declares, and a
 * length. The operator's actual request was *"just select, not write anything,
 * need it easy mode"*, and this is that — pick a channel, pick a subject, press
 * the button. Everything else was already known and is derived on the server
 * (see `EasyModeService`), never asked for.
 *
 * It is a **mode, not a replacement**. The written form is one tap away at the
 * top of the page and again from the footer here, and it is the only surface
 * that can answer a question easy mode cannot — see `unanswerable` below, which
 * is the one state that sends an operator there rather than merely offering it.
 *
 * ## Cards, not a form
 *
 * The phone is how this app is most often opened, so every choice on this
 * screen is a full-width tappable card that stacks in one column and only
 * splits into two at `sm`. Nothing here is a `Select`: a dropdown hides its
 * options behind a tap, which is precisely the work this mode exists to remove,
 * and it has nowhere to put the provenance badge every subject has to carry.
 *
 * ## Provenance is not decoration
 *
 * The rule that shapes the subject list: **a subject the operator did not write
 * must never be indistinguishable from one they did.** Every card carries its
 * origin as a badge and a sentence, the three origins are visually distinct,
 * and the operator's own queued topics are grouped first under their own
 * heading. `SUBJECT_STYLE` below is where that distinction is spent.
 */

/**
 * How each origin presents itself.
 *
 * The operator's own writing gets the solid badge and the primary tint; the two
 * kinds of writing they did not do get outline badges and no tint. That is the
 * whole visual argument, and it is deliberately not subtle — an operator
 * scanning a list of twelve sentences on a phone should be able to tell at a
 * glance which of them are theirs without reading a single badge.
 */
const SUBJECT_STYLE: Record<
  EasySubjectOrigin,
  { badge: string; variant: "default" | "outline" | "secondary"; card: string }
> = {
  queue: {
    badge: "Yours",
    variant: "default",
    // Written out in full rather than composed from a variable fragment:
    // Tailwind scans source text for whole class names, so an interpolated
    // `has-[:checked]:${x}` compiles to nothing and the selected state silently
    // stops rendering.
    card: "has-[:checked]:border-primary has-[:checked]:bg-primary/5",
  },
  suggested: {
    badge: "Written by AI",
    variant: "secondary",
    card: "has-[:checked]:border-primary",
  },
  starter: {
    badge: "Framecast idea",
    variant: "outline",
    card: "has-[:checked]:border-primary",
  },
};

/** The order the groups appear in, best-provenance first. A heading per group
 *  rather than a mixed list: interleaving the operator's own topics with
 *  machine-written ones would make the badges the only thing separating them,
 *  and a badge is easy to stop reading. */
const GROUP_ORDER: readonly {
  origin: EasySubjectOrigin;
  title: string;
  note: string;
}[] = [
  {
    origin: "queue",
    title: "Subjects you wrote",
    note: "Waiting in one of your schedule queues. Picking one here makes the video now and leaves the queue untouched — that schedule will still make its own video on this subject when its turn comes.",
  },
  {
    origin: "suggested",
    title: "Written for this channel, just now",
    note: "A model wrote these from your channel's niche a moment ago. Nobody has checked them.",
  },
  {
    origin: "starter",
    title: "Ideas that ship with Framecast",
    note: "Written for your script style, not for your channel. Fine to use, but they know nothing about what you make.",
  },
];

/** One subject, as a tappable card. */
function SubjectCard({ subject }: { subject: EasySubject }) {
  const style = SUBJECT_STYLE[subject.origin];

  return (
    <Label
      htmlFor={`easy-subject-${subject.key}`}
      className={cn(
        "hover:bg-accent/40 flex cursor-pointer items-start gap-3 rounded-md border p-3",
        style.card,
      )}
    >
      <RadioGroupItem
        id={`easy-subject-${subject.key}`}
        value={subject.topic}
        className="mt-0.5 shrink-0"
      />
      <span className="min-w-0 space-y-1.5">
        <span className="block text-sm leading-snug font-medium">{subject.topic}</span>
        <span className="flex flex-wrap items-center gap-2">
          <Badge variant={style.variant} className="font-normal">
            {style.badge}
          </Badge>
          <span className="text-muted-foreground text-xs font-normal">
            {subject.originLabel}
          </span>
        </span>
      </span>
    </Label>
  );
}

/** One channel, as a tappable card — or as a disabled panel naming what is
 *  missing, when nothing on it can take a video. */
function ChannelCard({ channel }: { channel: EasyChannel }) {
  if (!channel.plan) {
    return (
      <div className="text-muted-foreground space-y-1 rounded-md border border-dashed p-3">
        <p className="text-foreground text-sm font-medium">{channel.title}</p>
        <p className="text-xs">{channel.blockedReason}</p>
        <Link
          href="/projects"
          className="text-primary text-xs underline-offset-4 hover:underline"
        >
          Point a project at this channel
        </Link>
      </div>
    );
  }

  return (
    <Label
      htmlFor={`easy-channel-${channel.id}`}
      className="hover:bg-accent/40 has-[:checked]:border-primary flex cursor-pointer items-start gap-3 rounded-md border p-3"
    >
      <RadioGroupItem
        id={`easy-channel-${channel.id}`}
        value={channel.id}
        className="mt-0.5 shrink-0"
      />
      <span className="min-w-0 space-y-1">
        <span className="block font-medium">{channel.title}</span>
        <span className="text-muted-foreground block text-xs font-normal">
          {channel.niche} · {channel.tone}
        </span>
        {!channel.hasBrand && (
          <Badge variant="outline" className="font-normal">
            Using Framecast&apos;s defaults
          </Badge>
        )}
      </span>
    </Label>
  );
}

export function EasyModeFlow({
  channels,
  promptName,
  onWriteItMyself,
}: {
  channels: EasyChannel[];
  promptName: string;
  /** Switches the page to the written form. Passed in rather than routed to,
   *  because the mode is page state and the URL is deliberately unchanged —
   *  `/automation/generate` is the nav entry and stays one address. */
  onWriteItMyself: () => void;
}) {
  const router = useRouter();

  const usable = useMemo(
    () => channels.filter((channel) => channel.plan !== null),
    [channels],
  );

  const [channelId, setChannelId] = useState(usable[0]?.id ?? "");
  const [topic, setTopic] = useState("");
  /** Model-written subjects, per channel, for this page visit only. Keyed by
   *  channel so switching back and forth does not silently show one channel's
   *  suggestions under another's name — and does not re-bill for a list that
   *  was already paid for a moment ago. */
  const [suggested, setSuggested] = useState<Record<string, EasySubject[]>>({});
  const [isSuggesting, startSuggesting] = useTransition();
  const [isStarting, startVideo] = useTransition();

  /**
   * The client half of the double-submit guard, and the same one the written
   * form keeps for the same reason: `isStarting` disables the button only on
   * the next render, and `AutomationService` refuses a duplicate server-side.
   * This covers the window between the two, where a second tap — or a key
   * repeat on a focused button — would bill a second script.
   */
  const submitted = useRef(false);

  const channel = usable.find((entry) => entry.id === channelId) ?? null;
  const plan = channel?.plan ?? null;

  const subjects = useMemo(
    () => [...(channel?.subjects ?? []), ...(suggested[channelId] ?? [])],
    [channel, suggested, channelId],
  );

  const groups = GROUP_ORDER.map((group) => ({
    ...group,
    subjects: subjects.filter((subject) => subject.origin === group.origin),
  })).filter((group) => group.subjects.length > 0);

  /** Why the button is disabled, said before the operator has done anything
   *  wrong — the same convention, and the same `aria-live` treatment, the
   *  written form uses. `unanswerable` is the one entry here that is not a
   *  missing tap but a genuine limit of this mode, and it names the way out. */
  const blocked: string | null = (() => {
    if (!channelId) return "Pick a channel.";
    if (plan && plan.unanswerable.length > 0) {
      return (
        `Your "${promptName}" prompt needs an answer for ` +
        `${plan.unanswerable.join(", ")}, and nothing on this channel supplies ` +
        `one. Write this video yourself instead — that form can ask.`
      );
    }
    if (!topic.trim()) return "Pick a subject.";
    return null;
  })();

  function onSuggest(): void {
    if (!channelId || isSuggesting) return;

    startSuggesting(async () => {
      const response = await suggestSubjectsAction({ channelId });

      if (!response.ok) {
        toast.error("Could not write suggestions", {
          description: response.error.message,
        });
        return;
      }

      if (response.data.error) {
        toast.error("No new ideas this time", {
          description: response.data.error,
        });
        return;
      }

      setSuggested((current) => ({
        ...current,
        // Replaced rather than appended: a second tap means "these were not
        // right", and stacking twelve machine-written sentences under six the
        // operator has already rejected makes the list unreadable.
        [channelId]: response.data.subjects,
      }));
    });
  }

  function onSubmit(event: React.FormEvent): void {
    event.preventDefault();

    if (!channelId || !topic.trim() || blocked) return;
    if (submitted.current || isStarting) return;
    submitted.current = true;

    startVideo(async () => {
      const response = await startEasyVideoAction({ channelId, topic });

      if (!response.ok) {
        submitted.current = false;
        toast.error("Could not make that video", {
          description: response.error.message,
        });
        return;
      }

      toast.success("Script written, approved and queued", {
        description: `${response.data.wordCount} words. The render starts as soon as a worker picks it up.`,
      });

      // Same handoff the written form performs, to the same URL: a render takes
      // minutes on a worker that keeps going whether or not this tab is open,
      // so the run's progress lives at its own address rather than in this
      // component's state.
      router.replace(`/automation/generate?video=${response.data.videoId}`);
    });
  }

  if (usable.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Nothing here can take a video yet</CardTitle>
          <CardDescription>
            Easy mode files a video in a project that publishes to the channel
            you pick, because that is what decides where it can go live. None of
            your channels has one.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {channels.map((entry) => (
            <ChannelCard key={entry.id} channel={entry} />
          ))}
        </CardContent>
        <CardFooter>
          <Button asChild variant="outline">
            <Link href="/projects">Open projects</Link>
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {/* Channel. Skipped as a question when there is only one — a picker with
          one option is a tap that teaches nothing — but never skipped as an
          *answer*: the plan below names the channel either way. */}
      {channels.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle>Which channel?</CardTitle>
            <CardDescription>
              This decides how the video sounds and looks, and where it would
              publish. Everything else is worked out from it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FormFieldset label="Channel">
              <RadioGroup
                aria-label="Channel"
                value={channelId}
                onValueChange={(next) => {
                  setChannelId(next);
                  // The subject belonged to the old channel — a queued topic
                  // from one channel's schedule is not a subject for another's
                  // audience, and leaving it selected would carry it across
                  // silently.
                  setTopic("");
                }}
                className="grid gap-3 sm:grid-cols-2"
              >
                {channels.map((entry) => (
                  <ChannelCard key={entry.id} channel={entry} />
                ))}
              </RadioGroup>
            </FormFieldset>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>What is it about?</CardTitle>
          <CardDescription>
            Tap one. Every subject says where it came from — the ones you wrote
            are marked as yours.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          {groups.length === 0 ? (
            <p className="text-muted-foreground rounded-md border border-dashed px-3 py-4 text-sm">
              No subjects to offer for this channel yet.
            </p>
          ) : (
            <RadioGroup
              aria-label="Subject"
              value={topic}
              onValueChange={setTopic}
              className="space-y-5"
            >
              {groups.map((group) => (
                <FormFieldset
                  key={group.origin}
                  label={group.title}
                  description={group.note}
                >
                  <div className="grid gap-2">
                    {group.subjects.map((subject) => (
                      <SubjectCard key={subject.key} subject={subject} />
                    ))}
                  </div>
                </FormFieldset>
              ))}
            </RadioGroup>
          )}

          <div className="space-y-2 border-t pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={onSuggest}
              disabled={isSuggesting || !channelId}
              className="w-full sm:w-auto"
            >
              {isSuggesting ? <Loader2 className="animate-spin" /> : <Wand2 />}
              {suggested[channelId]?.length
                ? "Write different ideas"
                : `Write ideas for ${channel?.niche ?? "this channel"}`}
            </Button>
            {/* Said before the tap, not after it. This is the only button on
                the page that spends money without making a video, and an
                operator who did not know that would find it in a cost report a
                week later. */}
            <p className="text-muted-foreground text-xs">
              Asks a model for six subjects your channel&apos;s niche suits. One
              short call — pennies, not the price of a video — and nothing is
              made until you pick one and press the button below.
            </p>
          </div>
        </CardContent>
      </Card>

      {plan && (
        <Card>
          <CardHeader>
            <CardTitle>Ready when you are</CardTitle>
            {/*
              Shown rather than hidden, and shown as one sentence rather than as
              four labelled rows.

              The tension is real: four rows of derived values is very nearly
              the form this mode exists to remove, and it would read as
              something to fill in. But running with settings the operator
              cannot see is worse — a channel whose brand is wrong produces a
              script in the wrong voice for the wrong audience, and they find
              out after paying for a render. A sentence is read in two seconds,
              cannot be mistaken for an input, and catches exactly that.
              Everything else is one tap down, for the operator who wants it.
            */}
            <CardDescription>{plan.summary}</CardDescription>
          </CardHeader>

          <CardContent className="space-y-3">
            <details className="group">
              <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs">
                What Framecast decided, and where each answer came from
              </summary>
              <dl className="divide-border mt-2 divide-y text-sm">
                <div className="grid gap-1 py-2 sm:grid-cols-3">
                  <dt className="text-muted-foreground">Filed in</dt>
                  <dd className="sm:col-span-2">
                    {plan.projectName}
                    <span className="text-muted-foreground block text-xs">
                      Your most recently used project on {plan.channelTitle}. A
                      video has to sit in a project on the channel it publishes
                      to, so this is the only one it could be.
                    </span>
                  </dd>
                </div>

                {plan.answers.map((answer) => (
                  <div key={answer.label} className="grid gap-1 py-2 sm:grid-cols-3">
                    <dt className="text-muted-foreground">{answer.label}</dt>
                    <dd className="sm:col-span-2">
                      {answer.value}
                      <span className="text-muted-foreground block text-xs">
                        From {answer.source}
                        {answer.isFallback && " — nobody has set one, so this is Framecast's default"}
                      </span>
                    </dd>
                  </div>
                ))}
              </dl>
            </details>

            {channel && !channel.hasBrand && (
              <p className="text-muted-foreground bg-muted/40 rounded-md border px-3 py-2 text-xs">
                {channel.title} has never been described, so the tone, niche and
                voice above are Framecast&apos;s defaults —{" "}
                <span className="text-foreground font-medium">
                  the same ones every video from this channel already uses
                </span>
                . Nothing has been guessed, but nothing has been chosen either.{" "}
                <Link
                  href={`/channels/${channel.id}`}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  Describe {channel.title}
                </Link>{" "}
                and this page will use your answers instead.
              </p>
            )}

            <p className="text-muted-foreground text-xs">
              Framecast writes the script, approves it on your behalf so the
              render can start immediately, then runs narration, footage and the
              render.{" "}
              <span className="text-foreground font-medium">
                Nothing is published to YouTube — that stays a separate,
                deliberate click.
              </span>
            </p>
          </CardContent>

          <CardFooter className="flex flex-col items-stretch gap-3 sm:flex-row-reverse sm:items-center sm:justify-between">
            <Button
              type="submit"
              size="lg"
              disabled={Boolean(blocked) || isStarting}
              aria-describedby={blocked ? "easy-mode-blocked" : undefined}
            >
              {isStarting ? <Loader2 className="animate-spin" /> : <Sparkles />}
              Make the video
            </Button>

            <Button type="button" variant="ghost" onClick={onWriteItMyself}>
              <PenLine />
              Write it myself instead
            </Button>
          </CardFooter>
        </Card>
      )}

      {blocked && (
        <p
          id="easy-mode-blocked"
          role="status"
          aria-live="polite"
          className="text-muted-foreground text-center text-xs"
        >
          {blocked}
        </p>
      )}

      {isStarting && (
        <p className="text-muted-foreground text-center text-xs">
          Writing the script. This takes a few seconds and costs one Anthropic
          call — leave this page open until it lands.
        </p>
      )}
    </form>
  );
}
