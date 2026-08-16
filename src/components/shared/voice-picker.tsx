"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import Link from "next/link";
import { Loader2, TriangleAlert, Volume2 } from "lucide-react";

import { listVoicesAction } from "@/actions/channel.action";
import { MediaPlayer } from "@/components/shared/media-player";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { VoiceListStatus } from "@/services/brand.service";
import type { SpeechVoice } from "@/services/providers/types";

/**
 * One voice from the operator's own ElevenLabs account, as a row you can
 * listen to before choosing.
 *
 * The player is rendered only for the row currently being previewed, never for
 * all of them. `MediaPlayer` uses `preload="metadata"`, so twenty mounted
 * players would be twenty requests to ElevenLabs' sample storage on a screen
 * where the operator is usually here to do something else. One at a time also
 * happens to be what listening actually looks like.
 *
 * The `<label>` wraps only the radio and the text. Putting the player inside it
 * would make pressing play select the voice — the exact opposite of "hear it
 * before choosing".
 */
function VoiceChoice({
  value,
  name,
  detail,
  previewUrl,
  isPreviewing,
  onPreview,
}: {
  value: string;
  name: string;
  detail?: ReactNode;
  previewUrl?: string | null;
  isPreviewing: boolean;
  onPreview: () => void;
}) {
  const rowId = useId();

  return (
    <div className="rounded-lg border p-3 has-[button[data-state=checked]]:border-primary/60 has-[button[data-state=checked]]:bg-muted/40">
      <div className="flex items-start gap-3">
        <RadioGroupItem value={value} id={rowId} className="mt-1 shrink-0" />
        <label htmlFor={rowId} className="min-w-0 flex-1 cursor-pointer space-y-1">
          <span className="block text-sm font-medium">{name}</span>
          {detail}
        </label>

        {previewUrl && !isPreviewing && (
          <Button type="button" variant="outline" size="sm" onClick={onPreview}>
            <Volume2 />
            Hear it
          </Button>
        )}
      </div>

      {previewUrl && isPreviewing && (
        <MediaPlayer
          src={previewUrl}
          shape="audio"
          autoPlay
          label={`Preview of ${name}`}
          className="mt-2"
          errorMessage="ElevenLabs' sample for this voice could not be played. The voice itself is unaffected — this is only the preview."
        />
      )}
    </div>
  );
}

/** A row the caller prepends to the list, for an answer that is valid without
 *  being one of the account's voices — the branding screen's "use whatever
 *  ELEVENLABS_VOICE_ID is set to". Nothing here interprets its `value`; it is
 *  handed back through `onChange` exactly as given. */
export interface VoiceChoiceOption {
  value: string;
  name: string;
  detail?: ReactNode;
}

/**
 * The list of voices an operator can narrate with, fetched from their own
 * ElevenLabs account.
 *
 * The one control in this app whose options are not knowable in advance. Every
 * other picker is a closed set the app owns — fonts installed in the worker
 * image, footage styles, YouTube's assignable categories. Voices belong to *an
 * ElevenLabs account*, so the list is fetched with the operator's own stored
 * credential and there is no offline fallback of any kind: a hardcoded list of
 * plausible voice ids would offer voices this account may not have, and a
 * voice it does not have is not a wrong-looking dropdown, it is a narration
 * that fails after a video has already been queued.
 *
 * That makes the three failure states worth stating plainly rather than hiding
 * behind an empty list, which is why `listVoices` reports a status instead of
 * just returning `[]`:
 *
 * - **No credential.** Nothing was asked, because there was nothing to ask
 *   with. It says so and links to the page that fixes it.
 * - **Unreachable.** A credential exists and ElevenLabs did not answer. It
 *   says so and — crucially — keeps whatever is already selected visible and
 *   choosable, so an outage cannot cost the operator their voice.
 * - **Empty.** The account genuinely has no voices. Not an error, and not
 *   presented as one.
 *
 * ## Why this is shared rather than copied
 *
 * It is rendered on the channel branding screen (which voice this channel
 * narrates in, from now on) and in the re-narrate dialog on the video page
 * (which voice this one finished video is narrated again in). Those two
 * questions are different, but "the list of voices your account actually has,
 * each with a sample you can play" is one answer, and a second copy of it
 * would be a second place for the credential-missing wording, the outage
 * wording and the preview-one-at-a-time rule to drift. The two callers differ
 * only in what they hand in: branding prepends its deployment-default row and
 * treats a null selection as choosing it; the dialog prepends nothing, because
 * "re-narrate in no voice" is not a thing to ask for.
 */
export function VoicePicker({
  value,
  onChange,
  defaultChoice,
  unlistedName,
  unlistedDetail,
  ariaLabel,
  invalid,
  disabled,
}: {
  /** The currently selected row's value — a voice id, or `defaultChoice.value`. */
  value: string;
  /** Called with the chosen value and, for a real voice, the name ElevenLabs
   *  gave it at this moment. Null for `defaultChoice`, and null for a voice
   *  the fetched list does not contain: a name has to come from the list, and
   *  inventing one would be inventing a fact about somebody's account. */
  onChange: (value: string, name: string | null) => void;
  defaultChoice?: VoiceChoiceOption;
  /** What to call the selected voice when the fetched list has no such id —
   *  because the list could not be fetched, or the voice was removed from the
   *  account after it was chosen. Shown as its own row so the selection is
   *  never invisible: a radio group whose value matches no item renders as
   *  nothing selected, which reads as "no voice" when in fact there is one. */
  unlistedName?: string | null;
  unlistedDetail?: (voiceId: string) => ReactNode;
  ariaLabel: string;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const [voices, setVoices] = useState<SpeechVoice[]>([]);
  /** `loading` is this component's own fourth state — the service only ever
   *  answers with one of the three real ones. */
  const [status, setStatus] = useState<VoiceListStatus | "loading">("loading");
  const [previewing, setPreviewing] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadVoices() {
      const result = await listVoicesAction();

      if (cancelled) return;

      // The action cannot fail for a reachability reason — the service turns
      // every one of those into a status — so a rejected result means the
      // session check failed, which the operator will discover on submit.
      if (!result.ok) {
        setStatus("unavailable");
        return;
      }

      setVoices(result.data.voices);
      setStatus(result.data.status);
    }

    void loadVoices();

    return () => {
      cancelled = true;
    };
  }, []);

  const unlisted =
    value &&
    value !== defaultChoice?.value &&
    !voices.some((voice) => voice.voiceId === value)
      ? value
      : null;

  return (
    <div className="space-y-3">
      {status === "loading" && (
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          <Loader2 className="size-3.5 animate-spin" />
          Listing the voices on your ElevenLabs account…
        </p>
      )}

      {status === "no-credential" && (
        <p className="text-muted-foreground flex items-start gap-2 text-xs">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            No ElevenLabs key is stored, so there is no account to list voices
            from. Add one on the{" "}
            <Link href="/providers" className="underline underline-offset-3">
              Providers page
            </Link>{" "}
            and this list fills in. Narration needs that key anyway.
          </span>
        </p>
      )}

      {status === "unavailable" && (
        <p className="text-muted-foreground flex items-start gap-2 text-xs">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          ElevenLabs didn&apos;t answer, so the voices on your account
          couldn&apos;t be listed. Whatever is already chosen is unchanged —
          nothing below is a guess at what your account has.
        </p>
      )}

      {status === "ok" && voices.length === 0 && (
        <p className="text-muted-foreground text-xs">
          Your ElevenLabs account returned no voices. Adding one in ElevenLabs
          and reloading this page will list it.
        </p>
      )}

      <RadioGroup
        value={value}
        onValueChange={(next) =>
          onChange(
            next,
            voices.find((voice) => voice.voiceId === next)?.name ?? null,
          )
        }
        aria-label={ariaLabel}
        aria-invalid={invalid}
        disabled={disabled}
      >
        {defaultChoice && (
          <VoiceChoice
            value={defaultChoice.value}
            name={defaultChoice.name}
            detail={defaultChoice.detail}
            isPreviewing={false}
            onPreview={() => {}}
          />
        )}

        {unlisted && (
          <VoiceChoice
            value={unlisted}
            name={unlistedName ?? "Saved voice"}
            detail={
              unlistedDetail?.(unlisted) ?? (
                <span className="text-muted-foreground block text-xs">
                  <span className="font-mono">{unlisted}</span> — not in the
                  list above. It is still what narration uses.
                </span>
              )
            }
            isPreviewing={false}
            onPreview={() => {}}
          />
        )}

        {voices.map((voice) => (
          <VoiceChoice
            key={voice.voiceId}
            value={voice.voiceId}
            name={voice.name}
            detail={
              <>
                {voice.labels.length > 0 && (
                  <span className="flex flex-wrap gap-1">
                    {voice.labels.map((label) => (
                      <Badge
                        key={label.name}
                        variant="secondary"
                        className="font-normal"
                      >
                        {label.name}: {label.value}
                      </Badge>
                    ))}
                  </span>
                )}
                {voice.description && (
                  <span className="text-muted-foreground block text-xs">
                    {voice.description}
                  </span>
                )}
              </>
            }
            previewUrl={voice.previewUrl}
            isPreviewing={previewing === voice.voiceId}
            onPreview={() => setPreviewing(voice.voiceId)}
          />
        ))}
      </RadioGroup>
    </div>
  );
}
