import "server-only";

import { ConflictError, NotFoundError, ProviderError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { putObject, storagePath } from "@/lib/storage";
import { DEFAULT_STYLE } from "@/lib/video-style";
import { brandService } from "@/services/brand.service";
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
 * The name of the one voice this app can name without asking anybody.
 *
 * ElevenLabs' with-timestamps endpoint returns no human name for the voice,
 * only the id it was given — so `VoiceOver.voiceName`, which the narration
 * library lists, has to be filled in from somewhere else. This map is that
 * somewhere for the deployment default alone: `CwhRBWXzGAHq8TQ4Fs17` is the
 * default of `env.ELEVENLABS_VOICE_ID`, and it narrated every video in this
 * app before channels could choose.
 *
 * It must not grow. Now that voices are *chosen* rather than fixed, adding
 * entries here would be building a catalogue of voice ids in the app's source
 * — the same catalogue the picker deliberately refuses to invent, because the
 * only account that knows which voices exist is the operator's. A channel that
 * has chosen a voice carries the name ElevenLabs gave it at the moment it was
 * chosen (`ChannelBrand.voiceName`), which is both more accurate than a table
 * here and impossible to get wrong for a voice this map has never heard of.
 * The lookup below is therefore a fallback for the *unchosen* case only.
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
        // The operator's standing "re-narrate this in that voice" request, if
        // there is one. Read here rather than passed in as an option because
        // this is the method that has to *clear* it, and it can only clear it
        // atomically with the write that fulfils it — see the transaction at
        // the bottom of this method.
        renarrateVoiceId: true,
        renarrateVoiceName: true,
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

    /**
     * The voice the operator asked to re-narrate in, or null for an ordinary
     * run.
     *
     * A request is as good as `force`, and deliberately so: it is written by
     * `VideoService.requestRenarration`, which only ever writes it after
     * showing the operator what the re-synthesis costs. Making it a second
     * flag the caller has to remember to pair with `force` would be one more
     * way to arrive here with a new voice and refuse to use it.
     */
    const renarrateVoiceId = video.renarrateVoiceId;

    // The operator is on ElevenLabs' free tier (10,000 characters/month) and
    // one script is around 7,000. This check — and everything above it —
    // must run, and refuse, before the provider is ever called: a re-run
    // that called ElevenLabs and only discarded the result afterwards would
    // still spend the quota it was trying to protect.
    if (video.voiceOver && !opts.force && !renarrateVoiceId) {
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

    // Pre-flight, before a single character is spent. ElevenLabs reports an
    // exhausted allowance as a 401, which is indistinguishable from a bad key
    // at the call site — an operator with a perfectly good key can retry for
    // half an hour against something no retry can fix. The check itself costs
    // no quota, and a provider that cannot answer simply omits it.
    const quota = await this.provider.getQuota?.(apiKey);

    if (quota) {
      const remaining = quota.limitCharacters - quota.usedCharacters;

      if (content.length > remaining) {
        throw new ProviderError(
          "ELEVENLABS",
          `This script needs ${content.length.toLocaleString()} characters but only ` +
            `${remaining.toLocaleString()} remain of the ${quota.limitCharacters.toLocaleString()}-character ` +
            "allowance. Upgrade the ElevenLabs plan or wait for the allowance to reset.",
          false,
        );
      }
    }

    // The channel the video belongs to, read once: the voice below and the
    // pronunciation dictionary inside the try are both per channel, and this
    // is the same `channelId` both used before either had a reason to be
    // resolved early.
    const channelId = video.project?.channelId ?? null;

    /**
     * The voice, from the channel rather than from the environment.
     *
     * This one line is the whole behavioural change. `brandService.resolve`
     * applies the fallback — a channel that has never chosen a voice, a video
     * with no channel at all, and a brand lookup that failed all come back
     * with `env.ELEVENLABS_VOICE_ID`, which is exactly what this line used to
     * read directly. So nothing that narrates today sounds different
     * tomorrow, and two channels with different voices produce two different
     * requests to ElevenLabs.
     *
     * Safe to put in front of a synthesis because `resolve` is documented as
     * never throwing: an unreachable database or a malformed brand row cannot
     * become the reason a video has no narration.
     *
     * A standing re-narration request overrides the channel for this one
     * synthesis, and only for this one: the columns are cleared in the
     * transaction below, so the next video on the channel — and this video's
     * next narration, if it ever has one — is back on the channel's voice.
     * That is the honest reading of the request. The operator asked to hear
     * *this* video in another voice, not to re-brand the channel; the
     * branding screen is where the channel's own voice is changed, and doing
     * both from one click would silently restyle every future video.
     */
    const { voiceId, voiceName } = renarrateVoiceId
      ? { voiceId: renarrateVoiceId, voiceName: video.renarrateVoiceName }
      : await brandService.resolve(channelId);

    /**
     * A name for the narration library to print instead of a 20-character id.
     *
     * Two sources, in the order of how much they know. A channel that chose a
     * voice recorded what ElevenLabs called it at the time, which is right for
     * any voice on the operator's account including ones cloned yesterday. A
     * channel on the deployment default has no such record, and
     * `KNOWN_VOICE_NAMES` names that one voice — see its comment for why it
     * names only that one. Null when neither applies, which
     * `narration-library.tsx` already renders as the bare id.
     */
    const resolvedVoiceName = voiceName ?? KNOWN_VOICE_NAMES[voiceId] ?? null;

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
            voiceName: resolvedVoiceName,
            audioUrl,
            durationSeconds,
          },
          update: {
            provider: "ELEVENLABS",
            voiceId,
            voiceName: resolvedVoiceName,
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

        // The request is fulfilled the moment the new narration is committed,
        // and it is cleared here rather than by the caller so that the two
        // cannot come apart. Everything after this stage can fail and be
        // retried — footage, the render — and a retry that still saw the
        // request would call ElevenLabs again for a script's worth of
        // characters that have already been paid for once. Guarded on the
        // exact id that was honoured, so an operator who asked for a second,
        // different voice while this synthesis was in flight does not have
        // their newer request silently thrown away by this write.
        if (renarrateVoiceId) {
          await tx.video.updateMany({
            where: { id: videoId, userId, renarrateVoiceId },
            data: { renarrateVoiceId: null, renarrateVoiceName: null },
          });
        }

        await tx.activityLog.create({
          data: {
            userId,
            action: "voiceover.generate",
            entityType: "Video",
            entityId: videoId,
            message:
              `Generated narration (${durationSeconds}s, ${synthesized.characterCount} characters)` +
              // Named only on a re-narration. On an ordinary run the voice is
              // the channel's and saying so on every line would be noise; on
              // this one it is the entire reason the run happened, and the
              // activity log is what the video's own log stream shows.
              (renarrateVoiceId
                ? ` re-narrated in ${resolvedVoiceName ?? renarrateVoiceId}`
                : ""),
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
