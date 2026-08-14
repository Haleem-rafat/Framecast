import type { Metadata } from "next";
import { Suspense } from "react";
import { Clock, Mic } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { Reveal } from "@/components/shared/reveal";
import { StatCard, StatCardSkeleton } from "@/components/shared/stat-card";
import { NarrationLibrary } from "@/features/studio/components/narration-library";
import {
  VoiceAllowanceCard,
  VoiceNotes,
} from "@/features/studio/components/voice-allowance-card";
import { requireUser } from "@/server/session";
import { studioService } from "@/services/studio.service";
import { formatDuration } from "@/utils/format";

export const metadata: Metadata = { title: "Voice" };

/**
 * The allowance, streamed in rather than blocking the page.
 *
 * It is the only thing here that leaves the machine: decrypting the stored
 * credential and asking ElevenLabs for the account's usage. The narration
 * list beside it is one indexed query and should not wait behind a third
 * party's response time.
 */
async function VoiceAllowanceSection({ userId }: { userId: string }) {
  const allowance = await studioService.getVoiceAllowance(userId);

  return <VoiceAllowanceCard allowance={allowance} />;
}

export default async function StudioVoicePage() {
  const user = await requireUser();
  const narrations = await studioService.listNarrations(user.id);

  // Rows whose `durationSeconds` was never written contribute nothing rather
  // than making the total look smaller than it is by counting as zero — the
  // count in the hint is what says how many are actually behind the figure.
  const timed = narrations.filter((entry) => entry.durationSeconds !== null);
  const totalSeconds = timed.reduce(
    (total, entry) => total + (entry.durationSeconds ?? 0),
    0,
  );

  return (
    <>
      <PageHeader
        title="Voice"
        description="Every narration this studio has synthesised, and what is left of the allowance that pays for the next one."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="Narrations"
          value={String(narrations.length)}
          icon={Mic}
          hint="One per video that has reached the pipeline"
        />
        <StatCard
          label="Audio synthesised"
          value={totalSeconds === 0 ? "—" : formatDuration(totalSeconds)}
          icon={Clock}
          hint={
            timed.length === narrations.length
              ? "Total length of every narration"
              : `Across ${timed.length} of ${narrations.length} narrations with a recorded length`
          }
        />
        <Suspense fallback={<StatCardSkeleton />}>
          <VoiceAllowanceSection userId={user.id} />
        </Suspense>
      </div>

      <Reveal>
        <NarrationLibrary narrations={narrations} />
      </Reveal>

      <Reveal>
        <VoiceNotes />
      </Reveal>
    </>
  );
}
