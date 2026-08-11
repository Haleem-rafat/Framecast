import "server-only";

import { env } from "@/config/env";
import { ConflictError, NotFoundError, ProviderError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { putObject, storagePath } from "@/lib/storage";
import { DEFAULT_STYLE } from "@/lib/video-style";
import { providerCredentialService } from "@/services/provider-credential.service";
import type { AliasRule } from "@/services/pronunciation.service";
import { pronunciationService } from "@/services/pronunciation.service";
import { elevenLabsProvider } from "@/services/providers/elevenlabs.provider";
import { gatewayProvider } from "@/services/providers/gateway.provider";
import type {
  SpeechProvider,
  SpeechSynthesisResult,
} from "@/services/providers/types";
import { formatDuration, formatElapsed } from "@/utils/format";

export interface GenerateVoiceOverOptions {
  force?: boolean;
}

export interface GenerateVoiceOverResult {
  durationSeconds: number;
  characterCount: number;
}

/**
 * Reports a human-readable line as narration synthesis progresses. See
 * `FootageProgress` in footage.service.ts for why this is a callback rather
 * than a direct `console.log` — the same service runs inside the web app,
 * where stdout is the wrong medium.
 */
export type VoiceOverProgress = (message: string) => void;

const noopProgress: VoiceOverProgress = () => {};

/**
 * ElevenLabs' with-timestamps endpoint doesn't return a human name for the
 * voice, only its id. Filled in for the one voice this app defaults to;
 * anything else stores no name rather than a guess.
 */
const KNOWN_VOICE_NAMES: Record<string, string> = {
  CwhRBWXzGAHq8TQ4Fs17: "Roger",
};

/**
 * Asks the script model for a respelling of each term the narration is likely
 * to mangle, and turns the reply into alias rules.
 *
 * Applied without review, per the operator's decision. Two things make that
 * cheap to live with: the rules are aliases rather than phonemes, so a bad
 * entry produces a mispronunciation rather than invalid markup; and entries
 * persist on the channel, so a wrong guess is corrected once and never recurs.
 */
async function proposeAliases(terms: string[], userId: string): Promise<AliasRule[]> {
  try {
    const result = await gatewayProvider.generateScript({
      prompt:
        "For each term below, give a plain-English respelling that a " +
        "text-to-speech engine will pronounce correctly. Omit any term that " +
        "is already pronounced correctly. Reply with JSON only, no prose: " +
        `[{"term":"...","respelling":"..."}]. Terms: ${terms.join(", ")}`,
      apiKey: (await providerCredentialService.resolveKey(userId, "ANTHROPIC")) ?? undefined,
    });

    const parsed = JSON.parse(result.content) as { term?: string; respelling?: string }[];

    return parsed
      .filter((entry) => entry.term && entry.respelling && entry.term !== entry.respelling)
      .map((entry) => ({
        string_to_replace: entry.term!,
        type: "alias" as const,
        alias: entry.respelling!,
      }));
  } catch {
    // A model that answered with prose instead of JSON, or a provider that was
    // down, costs pronunciation quality — never the narration itself.
    return [];
  }
}

export class VoiceOverService {
  constructor(private readonly provider: SpeechProvider = elevenLabsProvider) {}

  async generate(
    userId: string,
    videoId: string,
    opts: GenerateVoiceOverOptions = {},
    onProgress: VoiceOverProgress = noopProgress,
  ): Promise<GenerateVoiceOverResult> {
    const video = await prisma.video.findFirst({
      where: { id: videoId, userId, deletedAt: null },
      select: {
        id: true,
        status: true,
        script: { select: { activeVersion: { select: { content: true } } } },
        voiceOver: { select: { id: true } },
        // The pronunciation dictionary is per channel, so terms learned on one
        // video carry to the next on the same channel.
        project: { select: { channelId: true } },
      },
    });

    if (!video) {
      throw new NotFoundError("Video");
    }

    // Narration is only eligible once the script has been approved —
    // videoService.approveScript is what moves a video from DRAFT to QUEUED,
    // and only ever does so once an active script version exists.
    //
    // GENERATING is accepted too: JobService.claimNext (job.service.ts)
    // claims a video by moving QUEUED -> GENERATING *before* runPipeline
    // ever reads the video, so inside the worker video.status is always
    // GENERATING, never QUEUED, by the time this method runs. Refusing
    // GENERATING here meant every worker-claimed video failed narration
    // immediately and became permanently unclaimable.
    //
    // This does not weaken Gate 1: GENERATING is only ever reachable through
    // QUEUED. Every writer of `status: "GENERATING"` either requires the row
    // to already be QUEUED (JobService.claimNext's own conditional update,
    // and pipeline-runner.ts's QUEUED -> GENERATING edge before handing off
    // to render.service), or is re-claiming a row already GENERATING/
    // RENDERING with a lapsed lease (claimNext's stranded-worker path) —
    // and RENDERING itself is only reachable from GENERATING
    // (render.service.ts). So every path to GENERATING traces back to a
    // QUEUED, and QUEUED is produced only by videoService.approveScript's
    // DRAFT -> QUEUED gate. "Status is QUEUED or GENERATING" therefore still
    // means "a human approved this script".
    if (video.status !== "QUEUED" && video.status !== "GENERATING") {
      throw new ConflictError(
        `Narration can only be generated once the script is approved. This video is ${video.status.toLowerCase()}.`,
      );
    }

    const content = video.script?.activeVersion?.content?.trim();

    if (!content) {
      throw new ConflictError("This video has no approved script to narrate.");
    }

    // The operator is on ElevenLabs' free tier (10,000 characters/month) and
    // one script is around 7,000. This check — and everything above it —
    // must run, and refuse, before the provider is ever called: a re-run
    // that called ElevenLabs and only discarded the result afterwards would
    // still spend the quota it was trying to protect.
    if (video.voiceOver && !opts.force) {
      throw new ConflictError(
        "Narration already exists for this video. Pass force to re-synthesise it " +
          "(this calls ElevenLabs again and spends quota).",
      );
    }

    const apiKey = await providerCredentialService.resolveKey(userId, "ELEVENLABS");

    if (!apiKey) {
      throw new ProviderError(
        "ELEVENLABS",
        "No ElevenLabs API key configured. Add one on the Providers page.",
        false,
      );
    }

    const voiceId = env.ELEVENLABS_VOICE_ID;

    // Declared outside the try so the catch block can report real spend if
    // the provider already succeeded and a later step (upload, transaction)
    // is what failed — mirrors script.service.ts's generate().
    let result: SpeechSynthesisResult | undefined;
    const startedAt = Date.now();

    onProgress(`sending ${content.length.toLocaleString()} characters to ElevenLabs …`);

    try {
      // A null locator is not an error — it means this narration is
      // synthesised without pronunciation help, which is exactly what every
      // video did before this existed. Nothing here may stop a video being
      // narrated at all.
      const channelId = video.project?.channelId;
      const locator = channelId
        ? await pronunciationService.ensureDictionary(apiKey, channelId, content, (terms) =>
            proposeAliases(terms, userId),
          )
        : null;

      const synthesized = await this.provider.synthesize({
        text: content,
        voiceId,
        apiKey,
        voice: DEFAULT_STYLE.voice,
        dictionaryLocators: locator ? [locator] : undefined,
      });
      result = synthesized;

      const characterEndTimes = synthesized.alignment.characterEndTimesSeconds;
      const lastEnd = characterEndTimes.length
        ? characterEndTimes[characterEndTimes.length - 1]
        : 0;
      // VoiceOver.durationSeconds is an Int column; the alignment's raw end
      // time is fractional.
      const durationSeconds = Math.round(lastEnd);

      onProgress(
        `synthesised ${formatDuration(durationSeconds)} of audio from ` +
          `${synthesized.characterCount.toLocaleString()} characters (${formatElapsed(Date.now() - startedAt)})`,
      );

      // Uploaded before the transaction opens: a storage call inside a DB
      // transaction would hold the connection open for the length of the
      // network round trip.
      const audioPath = storagePath(videoId, "audio", "narration.mp3");
      const audioUrl = await putObject(audioPath, synthesized.audio, "audio/mpeg");

      // The raw alignment is stored so captions can be rebuilt later without
      // re-billing the audio — that's the entire reason it's persisted
      // rather than only held in memory.
      const alignmentPath = storagePath(videoId, "captions", "alignment.json");
      await putObject(
        alignmentPath,
        Buffer.from(JSON.stringify(synthesized.alignment)),
        "application/json",
      );

      return await prisma.$transaction(async (tx) => {
        await tx.voiceOver.upsert({
          where: { videoId },
          create: {
            videoId,
            provider: "ELEVENLABS",
            voiceId,
            voiceName: KNOWN_VOICE_NAMES[voiceId] ?? null,
            audioUrl,
            durationSeconds,
          },
          update: {
            provider: "ELEVENLABS",
            voiceId,
            voiceName: KNOWN_VOICE_NAMES[voiceId] ?? null,
            audioUrl,
            durationSeconds,
          },
        });

        await tx.asset.create({
          data: {
            kind: "SUBTITLE",
            storagePath: alignmentPath,
            mimeType: "application/json",
            provider: "ELEVENLABS",
          },
        });

        await tx.providerUsage.create({
          data: {
            provider: "ELEVENLABS",
            operation: "voiceover.generate",
            inputTokens: synthesized.characterCount,
            succeeded: true,
          },
        });

        await tx.activityLog.create({
          data: {
            userId,
            action: "voiceover.generate",
            entityType: "Video",
            entityId: videoId,
            message: `Generated narration (${durationSeconds}s, ${synthesized.characterCount} characters)`,
          },
        });

        return { durationSeconds, characterCount: synthesized.characterCount };
      });
    } catch (error) {
      // Wasted spend still has to appear on the cost dashboard. If the
      // provider already resolved, real spend already happened even though
      // this generation ultimately failed — record its actual character
      // count rather than zero.
      if (result) {
        await prisma.providerUsage.create({
          data: {
            provider: "ELEVENLABS",
            operation: "voiceover.generate",
            inputTokens: result.characterCount,
            succeeded: false,
          },
        });
      }

      throw error;
    }
  }
}

export const voiceOverService = new VoiceOverService();
