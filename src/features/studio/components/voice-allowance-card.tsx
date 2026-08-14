import Link from "next/link";
import { Gauge } from "lucide-react";

import { StatCard } from "@/components/shared/stat-card";
import type { VoiceAllowance } from "@/features/studio/types";

/** Roughly what one finished script costs to synthesise — the figure
 *  `pipeline-runner.ts` and `voiceover.service.ts` both reach for when they
 *  warn about spending quota. */
const TYPICAL_SCRIPT_CHARACTERS = 7_000;

/**
 * What is left of the ElevenLabs character allowance.
 *
 * The number that decides whether the next video can be narrated at all.
 * `VoiceOverService` already refuses a synthesis that would not fit — that is
 * what its pre-flight quota check is for — but until now the only way to
 * discover the allowance was exhausted was to try to spend it, and ElevenLabs
 * reports an exhausted allowance as a 401, which at the call site is
 * indistinguishable from a bad key.
 *
 * Presentational and pure: the page owns the await, so it can stream this in
 * behind its own Suspense boundary.
 */
export function VoiceAllowanceCard({ allowance }: { allowance: VoiceAllowance }) {
  if (allowance.state === "no-key") {
    return (
      <StatCard
        label="ElevenLabs allowance"
        value="No key"
        icon={Gauge}
        hint="Nothing can be narrated until a key is stored"
      />
    );
  }

  if (allowance.state === "unavailable") {
    return (
      <StatCard
        label="ElevenLabs allowance"
        value="Unknown"
        icon={Gauge}
        hint="ElevenLabs did not answer — narration is unaffected"
      />
    );
  }

  const remaining = allowance.limitCharacters - allowance.usedCharacters;
  // An allowance below one script's worth is not "nearly full", it is "the
  // next video cannot be narrated". That threshold, not a percentage, is what
  // makes this red.
  const tone = remaining < TYPICAL_SCRIPT_CHARACTERS ? "danger" : "default";

  return (
    <StatCard
      label="ElevenLabs allowance"
      value={remaining.toLocaleString()}
      icon={Gauge}
      tone={tone}
      hint={`characters left of ${allowance.limitCharacters.toLocaleString()}`}
    />
  );
}

/**
 * The two things an operator would otherwise assume this page can do, said
 * plainly rather than implied by the absence of a control.
 */
export function VoiceNotes() {
  return (
    <p className="text-muted-foreground text-xs text-balance">
      Narration uses the voice this deployment is configured with (
      <code className="font-mono">ELEVENLABS_VOICE_ID</code>), the same one for
      every video. There is no per-video voice choice to make here: nothing in
      the pipeline reads a stored preference, so a picker on this page would
      change a row and not the audio. Re-synthesising is a pipeline action and
      lives on the video&apos;s own page, beside the script it would re-read.{" "}
      <Link href="/providers" className="underline underline-offset-3">
        Manage the ElevenLabs key
      </Link>
      .
    </p>
  );
}
