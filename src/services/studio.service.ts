import "server-only";

import type { AiProviderType, VideoStatus } from "@/generated/prisma/enums";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { providerCredentialService } from "@/services/provider-credential.service";
import { elevenLabsProvider } from "@/services/providers/elevenlabs.provider";
import type { SpeechProvider } from "@/services/providers/types";
import { thumbnailService, type ThumbnailService } from "@/services/thumbnail.service";

/**
 * The read model behind the Studio section: the same rows the per-video page
 * shows one at a time, gathered across every video the operator owns.
 *
 * Nothing here duplicates a write path. Scripts are written by
 * `script.service.ts`, narration by `voiceover.service.ts`, thumbnails by
 * `thumbnail.service.ts`, and the one method below that spends money
 * (`regenerateThumbnail`) delegates straight to the last of those rather than
 * reimplementing any of it — this service only adds the guards that stop the
 * spend happening when it could not possibly have an effect.
 *
 * Every query is scoped by walking back to `Video.userId`. `Script`,
 * `VoiceOver` and `Thumbnail` all hang off `Video` and carry no `userId` of
 * their own, so `where: { video: { userId, deletedAt: null } }` is the only
 * correct scoping — a query that filtered on the child alone would return
 * every operator's rows.
 */

/** How the citations and cue arrays are counted. Both are `Json?` columns, so
 *  anything that is not an array — a legacy row, a hand-edited one — counts as
 *  none rather than throwing. Mirrors `readStoredSources` in
 *  publish.service.ts, which makes the same allowance for the same columns. */
function countJsonArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export interface ScriptLibraryEntry {
  videoId: string;
  videoTitle: string;
  videoStatus: VideoStatus;
  projectName: string;
  /** Null when a `Script` row exists but its active version was deleted —
   *  `Script.activeVersionId` is `onDelete: SetNull`. */
  activeVersion: {
    id: string;
    version: number;
    wordCount: number;
    model: string | null;
    provider: AiProviderType | null;
    /** Ordered b-roll cues. Zero means footage falls back to the topic-level
     *  pool rather than matching the sentence being narrated. */
    cueCount: number;
    /** Citations for the description's SOURCES block. Zero means the
     *  published description carries no sources unless the script has an
     *  inline SOURCES section (see publish.service.ts). */
    sourceCount: number;
    createdAt: Date;
  } | null;
  versionCount: number;
  updatedAt: Date;
}

export interface ScriptVersionContent {
  version: number;
  wordCount: number;
  content: string;
  sources: string[];
  /** The rendered prompt actually sent, or null for an imported/edited
   *  version — see `ScriptService.importScript` on why those stay null. */
  prompt: string | null;
}

export interface NarrationEntry {
  videoId: string;
  videoTitle: string;
  videoStatus: VideoStatus;
  projectName: string;
  provider: AiProviderType;
  voiceId: string;
  voiceName: string | null;
  durationSeconds: number | null;
  /** False when the `VoiceOver` row exists but its object was never written.
   *  The player is only offered when this is true. */
  hasAudio: boolean;
  createdAt: Date;
}

/**
 * What ElevenLabs says is left of the allowance, or why it could not be
 * asked. Three states rather than a nullable number, because "no key stored"
 * and "the call failed" call for different copy and different next steps —
 * one is fixed on the Providers page, the other by waiting.
 */
export type VoiceAllowance =
  | { state: "no-key" }
  | { state: "unavailable" }
  | { state: "known"; usedCharacters: number; limitCharacters: number };

export interface ThumbnailVersionEntry {
  id: string;
  version: number;
  prompt: string;
  model: string | null;
  provider: AiProviderType | null;
  createdAt: Date;
}

export interface ThumbnailEntry {
  videoId: string;
  videoTitle: string;
  videoStatus: VideoStatus;
  projectName: string;
  activeVersionId: string | null;
  versions: ThumbnailVersionEntry[];
  /**
   * Whether an approved script exists to build a prompt from.
   * `ThumbnailService.generate` reads `script.activeVersion.content` and
   * returns null without it, so a regenerate offered here would spend a round
   * trip to produce nothing.
   */
  hasScript: boolean;
}

export class StudioService {
  constructor(
    /** Injected for the same reason `VoiceOverService` injects its own: a
     *  test must be able to ask what the page would show without a real
     *  ElevenLabs account answering. */
    private readonly speech: SpeechProvider = elevenLabsProvider,
    /** `Pick`, not the whole class, because this service only ever calls
     *  `generate` — the same narrowing `ScriptService` applies to its
     *  provider so a fake need not stub methods nobody calls. */
    private readonly thumbnails: Pick<ThumbnailService, "generate"> = thumbnailService,
  ) {}

  // -------------------------------------------------------------------------
  // Script
  // -------------------------------------------------------------------------

  async listScripts(userId: string): Promise<ScriptLibraryEntry[]> {
    const scripts = await prisma.script.findMany({
      where: { video: { userId, deletedAt: null } },
      orderBy: { updatedAt: "desc" },
      select: {
        updatedAt: true,
        video: {
          select: {
            id: true,
            title: true,
            status: true,
            project: { select: { name: true } },
          },
        },
        activeVersion: {
          select: {
            id: true,
            version: true,
            wordCount: true,
            model: true,
            provider: true,
            cues: true,
            sources: true,
            createdAt: true,
          },
        },
        _count: { select: { versions: true } },
      },
    });

    return scripts.map((script) => ({
      videoId: script.video.id,
      videoTitle: script.video.title,
      videoStatus: script.video.status,
      projectName: script.video.project.name,
      activeVersion: script.activeVersion
        ? {
            id: script.activeVersion.id,
            version: script.activeVersion.version,
            wordCount: script.activeVersion.wordCount,
            model: script.activeVersion.model,
            provider: script.activeVersion.provider,
            cueCount: countJsonArray(script.activeVersion.cues),
            sourceCount: countJsonArray(script.activeVersion.sources),
            createdAt: script.activeVersion.createdAt,
          }
        : null,
      versionCount: script._count.versions,
      updatedAt: script.updatedAt,
    }));
  }

  /**
   * One script's narration, fetched only when the operator asks to read it.
   *
   * Deliberately not part of `listScripts`. A real script is ~7,000
   * characters, and shipping every one of them to the browser so a dialog
   * *might* open would make the library page's payload scale with the
   * operator's whole back catalogue for content almost none of it displays.
   */
  async readScriptVersion(
    userId: string,
    versionId: string,
  ): Promise<ScriptVersionContent> {
    const version = await prisma.scriptVersion.findFirst({
      where: { id: versionId, script: { video: { userId, deletedAt: null } } },
      select: {
        version: true,
        wordCount: true,
        content: true,
        sources: true,
        prompt: true,
      },
    });

    if (!version) {
      throw new NotFoundError("Script version");
    }

    return {
      version: version.version,
      wordCount: version.wordCount,
      content: version.content,
      // Same defensive read as `countJsonArray` above: the column is `Json?`
      // and only the generated path guarantees a string[].
      sources: Array.isArray(version.sources)
        ? version.sources.filter((entry): entry is string => typeof entry === "string")
        : [],
      prompt: version.prompt,
    };
  }

  // -------------------------------------------------------------------------
  // Voice
  // -------------------------------------------------------------------------

  async listNarrations(userId: string): Promise<NarrationEntry[]> {
    const voiceOvers = await prisma.voiceOver.findMany({
      where: { video: { userId, deletedAt: null } },
      orderBy: { createdAt: "desc" },
      select: {
        provider: true,
        voiceId: true,
        voiceName: true,
        durationSeconds: true,
        audioUrl: true,
        createdAt: true,
        video: {
          select: {
            id: true,
            title: true,
            status: true,
            project: { select: { name: true } },
          },
        },
      },
    });

    return voiceOvers.map((voiceOver) => ({
      videoId: voiceOver.video.id,
      videoTitle: voiceOver.video.title,
      videoStatus: voiceOver.video.status,
      projectName: voiceOver.video.project.name,
      provider: voiceOver.provider,
      voiceId: voiceOver.voiceId,
      voiceName: voiceOver.voiceName,
      durationSeconds: voiceOver.durationSeconds,
      // The storage path, not the bytes: proving the object is still on disk
      // would cost one stat call per row, and the narration route already
      // reports a missing object as its own recoverable state.
      hasAudio: Boolean(voiceOver.audioUrl),
      createdAt: voiceOver.createdAt,
    }));
  }

  /**
   * What is left of the ElevenLabs allowance.
   *
   * Free to call — `getQuota` costs no characters, which is exactly why
   * `VoiceOverService` already uses it as a pre-flight check — so showing it
   * on a page load spends nothing. It is the number that decides whether the
   * next video can be narrated at all, and nothing else in this app surfaces
   * it until a synthesis is already being refused.
   */
  async getVoiceAllowance(userId: string): Promise<VoiceAllowance> {
    const apiKey = await providerCredentialService.resolveKey(userId, "ELEVENLABS");

    if (!apiKey) {
      return { state: "no-key" };
    }

    const quota = await this.speech.getQuota?.(apiKey);

    return quota
      ? {
          state: "known",
          usedCharacters: quota.usedCharacters,
          limitCharacters: quota.limitCharacters,
        }
      : { state: "unavailable" };
  }

  // -------------------------------------------------------------------------
  // Thumbnail
  // -------------------------------------------------------------------------

  async listThumbnails(userId: string): Promise<ThumbnailEntry[]> {
    const thumbnails = await prisma.thumbnail.findMany({
      where: { video: { userId, deletedAt: null } },
      orderBy: { updatedAt: "desc" },
      select: {
        activeVersionId: true,
        video: {
          select: {
            id: true,
            title: true,
            status: true,
            project: { select: { name: true } },
            script: { select: { activeVersionId: true } },
          },
        },
        versions: {
          orderBy: { version: "desc" },
          select: {
            id: true,
            version: true,
            prompt: true,
            model: true,
            provider: true,
            createdAt: true,
          },
        },
      },
    });

    return thumbnails.map((thumbnail) => ({
      videoId: thumbnail.video.id,
      videoTitle: thumbnail.video.title,
      videoStatus: thumbnail.video.status,
      projectName: thumbnail.video.project.name,
      activeVersionId: thumbnail.activeVersionId,
      versions: thumbnail.versions,
      hasScript: Boolean(thumbnail.video.script?.activeVersionId),
    }));
  }

  /**
   * How many finished videos would publish with a frame YouTube picked.
   *
   * Scoped to READY deliberately. A DRAFT has not reached the thumbnail stage
   * yet and a PUBLISHED video's chance has already gone — neither is
   * something an operator can act on. READY is exactly the set where a
   * missing thumbnail is both true and still fixable, since
   * `regenerateThumbnail` can produce one before the publish.
   */
  async countReadyVideosWithoutThumbnail(userId: string): Promise<number> {
    return prisma.video.count({
      where: { userId, deletedAt: null, status: "READY", thumbnail: null },
    });
  }

  /**
   * The storage path behind one thumbnail version, for the route that streams
   * its bytes.
   *
   * The ownership filter is the whole point of this method existing rather
   * than the route reading `thumbnailVersion.findUnique` itself:
   * `ThumbnailVersion` has no `userId`, so an id guessed or lifted from
   * another operator's page would otherwise resolve. A version this user does
   * not own must look exactly like one that does not exist.
   */
  async getThumbnailImagePath(userId: string, versionId: string): Promise<string> {
    const version = await prisma.thumbnailVersion.findFirst({
      where: { id: versionId, thumbnail: { video: { userId, deletedAt: null } } },
      select: { imageUrl: true },
    });

    if (!version) {
      throw new NotFoundError("Thumbnail version");
    }

    return version.imageUrl;
  }

  /**
   * Points a video's thumbnail at one of its existing versions.
   *
   * The counterpart to `ScriptService.setActiveVersion`, which `Thumbnail`
   * never had one of — the pipeline only ever appends and auto-activates, so
   * until now the newest generation was the only one reachable and every
   * earlier attempt was dead weight in the table.
   *
   * Refused once the video is PUBLISHED. `publish.service.ts` attaches the
   * active version to YouTube during the publish and never revisits it, so a
   * swap afterwards changes a row and nothing an audience can see — a control
   * that appears to work and does not is worse than no control.
   */
  async setActiveThumbnailVersion(
    userId: string,
    videoId: string,
    versionId: string,
  ): Promise<void> {
    const thumbnail = await prisma.thumbnail.findFirst({
      where: { videoId, video: { userId, deletedAt: null } },
      select: { id: true, video: { select: { status: true } } },
    });

    if (!thumbnail) {
      throw new NotFoundError("Thumbnail");
    }

    if (thumbnail.video.status === "PUBLISHED") {
      throw new ConflictError(
        "This video is already on YouTube with the thumbnail it published " +
          "with. Changing the active version here would not change what " +
          "viewers see — use YouTube Studio for that.",
      );
    }

    const version = await prisma.thumbnailVersion.findFirst({
      where: { id: versionId, thumbnailId: thumbnail.id },
      select: { id: true },
    });

    if (!version) {
      throw new NotFoundError("Thumbnail version");
    }

    await prisma.thumbnail.update({
      where: { id: thumbnail.id },
      data: { activeVersionId: version.id },
    });
  }

  /**
   * Generates another thumbnail for a video that already has one.
   *
   * This is the one method in this service that spends money — an image
   * generation through the AI gateway, plus an FFmpeg composite — so both
   * refusals below happen *before* `ThumbnailService.generate` is reached
   * rather than being discovered from a null return afterwards. The pattern
   * is `VoiceOverService`'s: a check that exists to protect a budget has to
   * refuse before the provider is called, or it has already failed.
   *
   * `ThumbnailService.generate` never throws (see its own doc comment) and
   * answers `null` for every internal failure, which is right for a pipeline
   * stage that must not fail a renderable video but useless to an operator
   * who just pressed a button. Null is converted here into a stated failure
   * so the page can say the spend produced nothing.
   */
  async regenerateThumbnail(userId: string, videoId: string): Promise<void> {
    const video = await prisma.video.findFirst({
      where: { id: videoId, userId, deletedAt: null },
      select: {
        status: true,
        script: { select: { activeVersionId: true } },
      },
    });

    if (!video) {
      throw new NotFoundError("Video");
    }

    if (video.status === "PUBLISHED") {
      throw new ConflictError(
        "This video is already on YouTube. Its thumbnail was attached during " +
          "the publish and nothing here can replace it, so generating another " +
          "one would only spend money.",
      );
    }

    if (!video.script?.activeVersionId) {
      throw new ConflictError(
        "A thumbnail is built from the script's opening, so this video needs " +
          "an active script version before one can be generated.",
      );
    }

    const imagePath = await this.thumbnails.generate(userId, videoId);

    if (imagePath === null) {
      throw new ConflictError(
        "The thumbnail could not be generated. The server log records why — " +
          "the most common causes are a missing AI gateway key and an image " +
          "the model returned too large for YouTube to accept.",
      );
    }
  }
}

export const studioService = new StudioService();
