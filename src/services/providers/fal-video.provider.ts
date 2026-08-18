import "server-only";

import type { AiProviderType } from "@/generated/prisma/enums";
import { ProviderError } from "@/lib/errors";
import type {
  GeneratedClip,
  VideoGenerationProvider,
  VideoGenerationRequest,
  VideoGenerationStatus,
} from "@/services/providers/types";

/**
 * fal.ai's queue API — the only text-to-video adapter in this codebase.
 *
 * ## The shape, measured rather than assumed
 *
 * Three endpoints under `https://queue.fal.run`, all of them requiring
 * `Authorization: Key <key>`:
 *
 *   POST /{model}                        -> { request_id, status: "IN_QUEUE" }
 *   GET  /{model}/requests/{id}/status   -> { status: IN_QUEUE|IN_PROGRESS|COMPLETED|FAILED }
 *   GET  /{model}/requests/{id}          -> { video: { url, content_type, ... }, seed }
 *
 * ## The trap, and why `fetchResult` is written the way it is
 *
 * **A request id that never existed answers `200 {"status":"COMPLETED"}`.**
 * That was measured, not guessed. So COMPLETED on its own is not evidence that
 * a generation happened — it is barely evidence that the id was ever real. The
 * only proof is a result carrying a `video.url`, which is why `fetchResult`
 * refuses a result without one instead of storing a zero-byte clip and marking
 * the job done. A pipeline that trusted the status alone would produce videos
 * with holes in them and a job table that said everything was fine.
 *
 * ## Why only two models
 *
 * `render-manifest.ts` requires an integer seed on every clip, and says why:
 * "without one a bad clip cannot be re-rolled without changing every other
 * clip." `fal-ai/kling-video/*` and `fal-ai/minimax/video-01` accept no seed at
 * all, so under this repo's own gate they cannot be used — a bad clip from
 * either would mean re-buying the whole manifest. They are deliberately absent
 * rather than listed-and-warned-about.
 *
 * ## What is NOT verified here
 *
 * The request bodies below were built from these models' published OpenAPI
 * schemas and one real generation against `wan-t2v`. `num_frames` in particular
 * is derived, not measured: the one clip that came back was 81 frames over
 * 5.07s, so the model's native rate is about 16fps and 81 is 16x5+1. Any
 * tighter constraint on that field — a step size, a minimum — would show up as
 * a 422 on submit rather than as a bad clip, which is the cheap direction for a
 * guess to be wrong in.
 */

/** Documented, stable, and the same host for all three calls. */
const FAL_QUEUE_BASE = "https://queue.fal.run";

/**
 * The frame rate this adapter ASKS `wan-t2v` for, and the ceiling it may ask.
 *
 * Both measured against the live API, and neither is in the model's OpenAPI
 * schema — which advertises `frames_per_second` and `num_frames` with no
 * bounds at all. Submitting 30fps/151 frames is accepted at the queue and then
 * refused ~146 seconds later with `frames_per_second <= 24` and
 * `num_frames <= 100`. That is the expensive direction to discover a limit in,
 * so both are enforced here instead.
 *
 * 24 rather than the model's own 16 default because the clip is resampled to
 * the pipeline's 30fps either way, and the source rate decides how much of that
 * resample is duplicated frames. Measured on the same prompt and seed, conformed
 * through `buildConformArgs`: a 16fps source lands at 13.1% pixel-identical
 * adjacent frames, a 24fps source at 6.1%. Same billed generation, half the
 * judder.
 *
 * The cost is reach: 100 frames at 24fps is 4.16 seconds, so this model can no
 * longer fill the top of the format's 4-5s band. `wanFrameCount` clamps rather
 * than overshooting into a 422.
 */
const WAN_REQUEST_FPS = 24;
const WAN_MAX_FRAMES = 100;

/**
 * The models this adapter will submit to, and how each expresses a length.
 *
 * A closed list, and not for tidiness. Every field below is a shape one model
 * accepts and another rejects — `veo3` wants `duration: "8s"` and would 422 on
 * `num_frames`; `wan-t2v` is the reverse — so "let the caller pass any model
 * id" is "let the caller pass a body the model will refuse, after the job row
 * has been written and before anyone finds out".
 */
type DurationEncoding = "num_frames" | "duration_string";

interface FalModel {
  /** What the operator is told this cost tier is, in a refusal sentence. */
  label: string;
  aspectRatios: readonly string[];
  durationEncoding: DurationEncoding;
  /** Only for `duration_string` models: the exact strings they accept. */
  durationChoices?: readonly string[];
}

export const FAL_MODELS: Record<string, FalModel> = {
  "fal-ai/wan-t2v": {
    label: "Wan text-to-video",
    aspectRatios: ["9:16", "16:9"],
    durationEncoding: "num_frames",
  },
  "fal-ai/veo3": {
    label: "Veo 3 (premium)",
    aspectRatios: ["9:16", "16:9"],
    durationEncoding: "duration_string",
    durationChoices: ["4s", "6s", "8s"],
  },
};

/**
 * The default, and it is the cheap one on purpose.
 *
 * `veo3` is reachable by naming it, and nothing in this app names it. A tier
 * that is already the most expensive thing here should not also default to the
 * most expensive model in it.
 */
export const DEFAULT_FAL_MODEL = "fal-ai/wan-t2v";

/** 429 and 5xx are the queue having a bad minute; everything else means the
 *  request itself is wrong and will be wrong again in five. */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * The frame count for a `num_frames` model, at `WAN_REQUEST_FPS`.
 *
 * Clamped at both ends rather than left open. The ceiling is the API's real,
 * undocumented `num_frames <= 100`; the floor is `MIN_CLIP_SECONDS` worth of
 * frames, so a manifest that somehow arrived here asking for half a second is
 * refused by arithmetic rather than bought and thrown away. A 40-second clip is
 * likewise clamped instead of 422-ing after the job row is already written.
 *
 * Note the ceiling binds before the format's own `MAX_CLIP_SECONDS` does:
 * 5 x 24 = 120 frames, and the model stops at 100. See `WAN_REQUEST_FPS`.
 */
export function wanFrameCount(durationSeconds: number): number {
  const frames = Math.round(durationSeconds * WAN_REQUEST_FPS);

  return Math.min(Math.max(frames, 4 * WAN_REQUEST_FPS), WAN_MAX_FRAMES);
}

/** The nearest length the model actually offers, never the requested one
 *  rounded silently to something it does not accept. */
export function nearestDurationChoice(
  durationSeconds: number,
  choices: readonly string[],
): string {
  return choices.reduce((best, choice) => {
    const distance = Math.abs(Number.parseFloat(choice) - durationSeconds);
    const bestDistance = Math.abs(Number.parseFloat(best) - durationSeconds);

    return distance < bestDistance ? choice : best;
  });
}

/** Every request body this adapter can build, in one place, so the two models'
 *  differences are visible side by side rather than spread through `submit`. */
export function buildFalRequestBody(
  request: VideoGenerationRequest,
): Record<string, unknown> {
  const model = FAL_MODELS[request.model];

  if (!model) {
    throw new ProviderError(
      "FAL",
      `${request.model} is not a model this app will submit to. ` +
        `Supported: ${Object.keys(FAL_MODELS).join(", ")}.`,
      false,
    );
  }

  if (!model.aspectRatios.includes(request.aspectRatio)) {
    throw new ProviderError(
      "FAL",
      `${model.label} cannot render ${request.aspectRatio}. It accepts ` +
        `${model.aspectRatios.join(" or ")}.`,
      false,
    );
  }

  const body: Record<string, unknown> = {
    prompt: request.prompt,
    aspect_ratio: request.aspectRatio,
    // The field this whole design turns on. Verified honoured on `wan-t2v`:
    // 100001 went out and 100001 came back.
    seed: request.seed,
  };

  if (request.negativePrompt) {
    body.negative_prompt = request.negativePrompt;
  }

  if (model.durationEncoding === "num_frames") {
    body.num_frames = wanFrameCount(request.durationSeconds);
    // Sent explicitly rather than left to the model's 16 default — see
    // `WAN_REQUEST_FPS` for the measurement that made this worth a field.
    body.frames_per_second = WAN_REQUEST_FPS;
  } else {
    body.duration = nearestDurationChoice(
      request.durationSeconds,
      model.durationChoices ?? [],
    );
  }

  // `resolution` is deliberately not set. The model's default is 720p and the
  // one measured generation came back 720x1280, which the conform step in
  // motion.service.ts then upscales to the pipeline's 1080x1920 — a real
  // softness cost, and the honest place to record it is here rather than in a
  // constant asking for a resolution nobody has confirmed this model offers.
  return body;
}

function authHeaders(apiKey: string): Record<string, string> {
  // `Key <token>`, not `Bearer`. Without this header every endpoint answers
  // 401 — which is also what makes `verifyKey` below a real check.
  return { Authorization: `Key ${apiKey}` };
}

interface FalSubmitResponse {
  request_id?: string;
  status?: string;
}

interface FalStatusResponse {
  status?: string;
  error?: unknown;
  detail?: unknown;
}

interface FalResultResponse {
  video?: { url?: string; content_type?: string; file_size?: number };
  seed?: number;
}

/** The provider's own words for the job row, without inventing any. */
function detailOf(body: FalStatusResponse): string | null {
  const raw = body.error ?? body.detail;

  if (raw === undefined || raw === null) return null;

  return typeof raw === "string" ? raw : JSON.stringify(raw);
}

export class FalVideoProvider implements VideoGenerationProvider {
  readonly provider: AiProviderType = "FAL";

  /** `fetch` is a constructor parameter for the same reason it is one on
   *  `ProviderCredentialService.test`: every test in this repo must be able to
   *  exercise this adapter without a key and without a network. */
  constructor(private readonly fetchClient: typeof fetch = fetch) {}

  async submit(request: VideoGenerationRequest): Promise<string> {
    // Built before the request is sent, so a body this adapter refuses to
    // construct costs nothing. Both refusals above are non-retryable.
    const body = buildFalRequestBody(request);
    const response = await this.call(
      `${FAL_QUEUE_BASE}/${request.model}`,
      {
        method: "POST",
        headers: { ...authHeaders(request.apiKey), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      "the generation request",
    );

    const parsed = (await this.json(response, "the generation request")) as FalSubmitResponse;

    if (!parsed.request_id) {
      // Retryable: a submit that returned 200 with no id may or may not have
      // started a generation, and the caller's own attempt counter is what
      // bounds how many times that ambiguity is paid for.
      throw new ProviderError(
        "FAL",
        "fal.ai accepted the request but returned no request id, so the " +
          "generation cannot be polled or collected.",
        true,
      );
    }

    return parsed.request_id;
  }

  async checkStatus(
    model: string,
    requestId: string,
    apiKey: string,
  ): Promise<VideoGenerationStatus> {
    const response = await this.call(
      `${FAL_QUEUE_BASE}/${model}/requests/${encodeURIComponent(requestId)}/status`,
      { headers: authHeaders(apiKey) },
      "the status poll",
    );

    const parsed = (await this.json(response, "the status poll")) as FalStatusResponse;
    const detail = detailOf(parsed);

    switch (parsed.status) {
      case "COMPLETED":
        return { state: "COMPLETED", detail };
      case "FAILED":
        return { state: "FAILED", detail };
      case "IN_QUEUE":
      case "IN_PROGRESS":
        return { state: "PENDING", detail };
      default:
        // An unrecognised status is reported as still running, on purpose. The
        // alternative — call it FAILED — burns an attempt and re-submits, which
        // is a second bill for a generation that may be perfectly healthy and
        // merely in a state this adapter has not seen. The job's own deadline
        // ends it either way; only one of the two options can spend money.
        return {
          state: "PENDING",
          detail: detail ?? `fal.ai reported an unfamiliar status: ${parsed.status}`,
        };
    }
  }

  async fetchResult(
    model: string,
    requestId: string,
    apiKey: string,
  ): Promise<GeneratedClip> {
    const response = await this.call(
      `${FAL_QUEUE_BASE}/${model}/requests/${encodeURIComponent(requestId)}`,
      { headers: authHeaders(apiKey) },
      "the result request",
    );

    const parsed = (await this.json(response, "the result request")) as FalResultResponse;
    const url = parsed.video?.url;

    if (!url) {
      // The measured trap, spelled out. A bogus request id answers
      // 200 COMPLETED, so a result with no `video.url` is the ONLY signal that
      // separates "this generation finished" from "this id never existed".
      // Treated as non-retryable: re-polling an id the queue has nothing for
      // will keep having nothing for it.
      throw new ProviderError(
        "FAL",
        `fal.ai reported request ${requestId} complete but returned no video. ` +
          `A request id that never existed answers COMPLETED too, so this is ` +
          `not a generation that can be collected.`,
        false,
      );
    }

    // Plain https, no credential — the result url is pre-signed by fal and
    // sending the key to a CDN host would leak it well outside the API.
    let download: Response;

    try {
      download = await this.fetchClient(url);
    } catch (cause) {
      throw new ProviderError("FAL", "Could not download the generated clip.", true, {
        cause,
      });
    }

    if (!download.ok) {
      throw new ProviderError(
        "FAL",
        `Downloading the generated clip failed with status ${download.status} ` +
          `${download.statusText}.`,
        isRetryable(download.status),
      );
    }

    return {
      data: Buffer.from(await download.arrayBuffer()),
      contentType: parsed.video?.content_type ?? "video/mp4",
      seed: typeof parsed.seed === "number" ? parsed.seed : null,
    };
  }

  /**
   * Asks the queue about a request id that cannot exist.
   *
   * The cheapest possible check, and a real one rather than a shape test on the
   * string: unauthenticated, every fal endpoint answers 401, so a 200 here means
   * the key was accepted. It starts no generation and bills nothing — which is
   * the property that matters, because the obvious alternative (submit
   * something tiny) would charge the operator for pressing "test".
   *
   * A network failure is `false` with the reason on the thrown error rather
   * than a silent pass. `ProviderCredentialService.test` already turns a thrown
   * `ProviderError` into a red badge with its message.
   */
  async verifyKey(apiKey: string): Promise<boolean> {
    const url =
      `${FAL_QUEUE_BASE}/${DEFAULT_FAL_MODEL}/requests/` +
      `00000000-0000-0000-0000-000000000000/status`;

    let response: Response;

    try {
      response = await this.fetchClient(url, { headers: authHeaders(apiKey) });
    } catch (cause) {
      throw new ProviderError("FAL", "Could not reach fal.ai to check the key.", true, {
        cause,
      });
    }

    if (response.status === 401 || response.status === 403) {
      return false;
    }

    // 404 counts as accepted, and that is the whole point of asking about an id
    // that cannot exist: whether the queue says "never heard of it" or answers
    // for it, it only got as far as *answering* because the key was good.
    if (response.ok || response.status === 404) {
      return true;
    }

    // A 5xx says nothing about the key. Reporting it as a bad key would send an
    // operator to rotate a credential that was fine.
    throw new ProviderError(
      "FAL",
      `fal.ai answered ${response.status} ${response.statusText} to the key ` +
        `check, which says nothing about whether the key is valid.`,
      isRetryable(response.status),
    );
  }

  /** One place that turns a transport failure and a non-2xx into the same
   *  `ProviderError` shape, so the three endpoints above do not each grow their
   *  own slightly different version of it. */
  private async call(url: string, init: RequestInit, label: string): Promise<Response> {
    let response: Response;

    try {
      response = await this.fetchClient(url, init);
    } catch (cause) {
      // No status to classify by — the request never reached fal.
      throw new ProviderError("FAL", `Could not reach fal.ai for ${label}.`, true, {
        cause,
      });
    }

    if (!response.ok) {
      throw new ProviderError(
        "FAL",
        `fal.ai answered ${response.status} ${response.statusText} to ${label}.`,
        isRetryable(response.status),
      );
    }

    return response;
  }

  private async json(response: Response, label: string): Promise<unknown> {
    try {
      return await response.json();
    } catch (cause) {
      throw new ProviderError(
        "FAL",
        `fal.ai's answer to ${label} could not be parsed.`,
        false,
        { cause },
      );
    }
  }
}

export const falVideoProvider = new FalVideoProvider();
