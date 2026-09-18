"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CircleAlert, Save } from "lucide-react";
import { toast } from "sonner";

import { updateBrandingAction } from "@/actions/channel.action";
import { createSeriesAction } from "@/actions/series.action";
import {
  WizardFooter,
  WizardFrame,
  WizardProgress,
  WizardStepHeader,
} from "@/components/shared/wizard/wizard-frame";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import type { ChannelBranding } from "@/services/brand.service";
import type { SeriesSetup } from "@/services/series.service";

import { CaptionsStep, LookStep, MusicStep, VoiceStep } from "./channel-steps";
import { ReviewStep, ScheduleStep } from "./finish-steps";
import { findNichePreset, type NichePreset } from "./niche-presets";
import {
  applyNichePreset,
  brandChanges,
  chooseChannel,
  chooseScriptStyle,
  firstIncompleteStep,
  initialDraft,
  reconcileDraft,
  toBrandingInput,
  toCreateSeriesInput,
  validateStep,
  WIZARD_STEPS,
  type SeriesDraft,
  type WizardStepId,
} from "./series-wizard-state";
import { ChannelStep, NicheStep, TopicsStep, type StepProps } from "./show-steps";

/**
 * Where an unfinished draft lives between page loads.
 *
 * Session storage, not local: the draft should survive a refresh and the round
 * trip through Google to connect a channel — both of which stay in this tab —
 * but not reappear days later in a different tab as somebody's half-made show.
 * Every access is guarded, because a private window or blocked site data makes
 * the accessor throw, and the wizard has to work without it.
 */
const STORAGE_KEY = "framecast:new-series-draft";

const STEP_COPY: Record<WizardStepId, { title: string; description: string }> = {
  niche: {
    title: "Choose a niche",
    description: "Start from a preset, or pick a script style yourself.",
  },
  topics: {
    title: "Name it and list the topics",
    description: "Each episode takes the next topic down the list.",
  },
  channel: {
    title: "Channel and format",
    description: "Where episodes are published, and what shape they come out.",
  },
  voice: { title: "Narration voice", description: "Who reads every episode." },
  music: {
    title: "Background music",
    description: "The mood the music under the narration is searched for.",
  },
  look: {
    title: "Look",
    description: "Where the pictures come from, and how they are drawn.",
  },
  captions: { title: "Captions", description: "How the words appear on screen." },
  schedule: { title: "Schedule", description: "How often a new episode is made." },
  review: {
    title: "Publish and review",
    description: "Check everything once. Nothing is saved until you press Create.",
  },
};

/** The four steps whose answers are the channel's rather than the series'. */
const CHANNEL_STEPS = new Set<WizardStepId>(["voice", "music", "look", "captions"]);

/** How the last Create attempt ended, when it did not end on the new series'
 *  page. Kept on screen rather than only toasted: this is the one message the
 *  operator must be able to read twice. */
type Outcome =
  | { kind: "brand-failed"; message: string; changes: string[] }
  | { kind: "series-failed"; message: string; saved: string[] }
  | null;

function readStoredDraft(): Partial<SeriesDraft> | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<SeriesDraft>) : null;
  } catch {
    return null;
  }
}

function clearStoredDraft(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear if storage was never usable.
  }
}

/**
 * The new-series flow: one decision per screen, the step in the URL.
 *
 * The step lives in `?step=` so the browser's Back and a refresh both land
 * where the operator expects, and the draft lives in client state mirrored to
 * session storage so a refresh does not throw the answers away. A URL naming a
 * step past the first unanswered one is clamped back to it — a bookmark or a
 * hand-edited query string can never skip a question.
 *
 * Nothing is written until Create. Then, in this order: the channel settings
 * the operator changed (only those, and only if any), then the series. Brand
 * first because it is the half that is safe to retry: if the series then fails,
 * pressing Create again sends only the series, since the channel already holds
 * what the draft says. The reverse order could leave a created series behind a
 * failed brand write, and a retry would make a second series.
 */
export function SeriesWizard({
  setup,
  brandings: initialBrandings,
  timeZones,
}: {
  setup: SeriesSetup;
  /** Every channel's current brand, keyed by channel id. */
  brandings: Record<string, ChannelBranding>;
  /** IANA zone names, resolved on the server so the list is identical for
   *  everyone rather than varying with the browser's ICU build. */
  timeZones: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  // Replaced after a successful brand write, so the draft is compared against
  // what the channel holds *now* and a retried Create does not resend it.
  const [brandings, setBrandings] = useState(initialBrandings);
  const context = useMemo(() => ({ setup, brandings }), [setup, brandings]);

  const [draft, setDraft] = useState<SeriesDraft>(() =>
    initialDraft({ setup, brandings: initialBrandings }),
  );
  /** False until the stored draft and the browser's timezone have been read.
   *  Both are browser-only, so reading them during render would be a
   *  hydration mismatch; until then the wizard shows a skeleton rather than a
   *  step built from the wrong draft. */
  const [hydrated, setHydrated] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  useEffect(() => {
    const stored = readStoredDraft();

    setDraft((current) => {
      const base = stored
        ? reconcileDraft(stored, { setup, brandings: initialBrandings })
        : current;

      if (base.timeZone && timeZones.includes(base.timeZone)) {
        return base;
      }

      const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;

      return { ...base, timeZone: timeZones.includes(detected) ? detected : "UTC" };
    });
    setHydrated(true);
  }, [setup, initialBrandings, timeZones]);

  useEffect(() => {
    if (!hydrated) {
      return;
    }

    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
    } catch {
      // A draft that cannot be kept only costs a refresh; the flow still works.
    }
  }, [draft, hydrated]);

  const requested = Number.parseInt(searchParams.get("step") ?? "1", 10) - 1;
  const reachable = firstIncompleteStep(draft, context);
  const index = Math.min(Math.max(Number.isFinite(requested) ? requested : 0, 0), reachable);
  const step = WIZARD_STEPS[index];

  useEffect(() => {
    if (hydrated && requested !== index) {
      router.replace(`${pathname}?step=${index + 1}`, { scroll: false });
    }
  }, [hydrated, requested, index, pathname, router]);

  if (!hydrated) {
    return (
      <WizardFrame>
        <Skeleton className="h-1.5 w-full" />
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-64 w-full" />
      </WizardFrame>
    );
  }

  const channel = setup.channels.find((entry) => entry.id === draft.channelId) ?? null;
  const channelTitle = channel?.title ?? "this channel";
  const branding = brandings[draft.channelId] ?? null;
  const changes = branding ? brandChanges(draft, branding) : [];
  const blocked = validateStep(step.id, draft, context);
  const headingId = `wizard-step-${step.id}`;

  function update(next: (current: SeriesDraft) => SeriesDraft): void {
    setDraft(next);
    setOutcome(null);
  }

  function goTo(target: number): void {
    router.push(`${pathname}?step=${target + 1}`, { scroll: false });
    window.scrollTo({ top: 0 });
  }

  function goToStep(id: WizardStepId): void {
    goTo(WIZARD_STEPS.findIndex((entry) => entry.id === id));
  }

  function create(): void {
    const channelId = draft.channelId;
    const brandInput = branding && changes.length > 0 ? toBrandingInput(draft, branding) : null;
    const seriesInput = toCreateSeriesInput(draft);

    startTransition(async () => {
      setOutcome(null);

      if (brandInput) {
        const saved = await updateBrandingAction(brandInput);

        if (!saved.ok) {
          setOutcome({ kind: "brand-failed", message: saved.error.message, changes });
          return;
        }

        setBrandings((current) => ({ ...current, [channelId]: saved.data }));
      }

      const created = await createSeriesAction(seriesInput);

      if (!created.ok) {
        setOutcome({
          kind: "series-failed",
          message: created.error.message,
          saved: brandInput ? changes : [],
        });
        return;
      }

      clearStoredDraft();
      toast.success("Series created", {
        description: `${seriesInput.topics.length} topic${
          seriesInput.topics.length === 1 ? "" : "s"
        } queued${
          brandInput ? `, and ${channelTitle}'s ${changes.join(", ")} saved` : ""
        }. The first scheduled episode is at the next occurrence, not now — or press "Make one now".`,
      });
      router.push(`/automation/series/${created.data.id}`);
      router.refresh();
    });
  }

  const props: StepProps = { draft, update, context, headingId };
  const isReview = step.id === "review";
  const musicUnchanged =
    step.id === "music" && (draft.brand?.musicQuery ?? null) === (branding?.musicQuery ?? null);

  return (
    <WizardFrame>
      <WizardProgress steps={WIZARD_STEPS} current={index} />

      <WizardStepHeader
        headingId={headingId}
        title={STEP_COPY[step.id].title}
        description={STEP_COPY[step.id].description}
        stepNumber={index + 1}
        stepCount={WIZARD_STEPS.length}
        optional={step.optional}
        note={CHANNEL_STEPS.has(step.id) ? `Applies to every video on ${channelTitle}` : undefined}
      />

      {step.id === "niche" && (
        <NicheStep
          {...props}
          onApplyPreset={(preset: NichePreset) =>
            update((current) =>
              applyNichePreset(
                current,
                preset,
                findNichePreset(current.nichePresetId),
                setup.scriptStyles,
              ),
            )
          }
          onChooseStyle={(id) =>
            update((current) => chooseScriptStyle(current, id, setup.scriptStyles))
          }
        />
      )}
      {step.id === "topics" && <TopicsStep {...props} />}
      {step.id === "channel" && (
        <ChannelStep
          {...props}
          onChooseChannel={(id) => update((current) => chooseChannel(current, id, context))}
        />
      )}
      {step.id === "voice" && <VoiceStep {...props} />}
      {step.id === "music" && (
        <MusicStep {...props} savedQuery={branding?.musicQuery ?? null} />
      )}
      {step.id === "look" && (
        <LookStep
          {...props}
          channelTitle={channelTitle}
          hasCharacterSheet={Boolean(branding?.characterSheetPath)}
          stylePreset={branding?.stylePreset ?? null}
        />
      )}
      {step.id === "captions" && <CaptionsStep {...props} />}
      {step.id === "schedule" && <ScheduleStep {...props} timeZones={timeZones} />}
      {isReview && (
        <ReviewStep
          {...props}
          channelTitle={channelTitle}
          changes={changes}
          onEdit={goToStep}
          outcome={<OutcomeNotice outcome={outcome} channelTitle={channelTitle} />}
        />
      )}

      <WizardFooter
        onBack={index > 0 ? () => goTo(index - 1) : undefined}
        onPrimary={() => (isReview ? create() : goTo(index + 1))}
        primaryLabel={isReview ? "Create series" : musicUnchanged ? "Skip" : "Continue"}
        primaryIcon={isReview ? <Save /> : undefined}
        primaryDisabled={Boolean(blocked)}
        pending={isPending}
        blockedReason={blocked}
      />
    </WizardFrame>
  );
}

/**
 * What a failed Create did and did not save, in so many words.
 *
 * The two writes can fail independently, and "something went wrong" would
 * leave the operator unable to tell whether their channel now narrates in a
 * different voice. So each case names what landed.
 */
function OutcomeNotice({
  outcome,
  channelTitle,
}: {
  outcome: Outcome;
  channelTitle: string;
}) {
  if (!outcome) {
    return null;
  }

  if (outcome.kind === "brand-failed") {
    return (
      <Alert variant="destructive" role="alert">
        <CircleAlert />
        <AlertTitle>Nothing was saved</AlertTitle>
        <AlertDescription>
          {channelTitle}&apos;s {outcome.changes.join(", ")} could not be saved, so the
          series was not created either: {outcome.message}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="destructive" role="alert">
      <CircleAlert />
      <AlertTitle>The series was not created</AlertTitle>
      <AlertDescription>
        {outcome.saved.length > 0 ? (
          <p>
            {channelTitle}&apos;s {outcome.saved.join(", ")}{" "}
            {outcome.saved.length === 1 ? "was" : "were"} saved, and every video on
            that channel now uses {outcome.saved.length === 1 ? "it" : "them"}. The
            series itself failed: {outcome.message} Pressing Create again sends only
            the series.
          </p>
        ) : (
          <p>Nothing was saved: {outcome.message}</p>
        )}
      </AlertDescription>
    </Alert>
  );
}
