import { afterEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "@/lib/errors";
import {
  buildFalRequestBody,
  DEFAULT_FAL_MODEL,
  FalVideoProvider,
  nearestDurationChoice,
  wanFrameCount,
} from "@/services/providers/fal-video.provider";
import type { VideoGenerationRequest } from "@/services/providers/types";

/**
 * The fal.ai queue adapter, with no key and no network.
 *
 * `fetch` is injected into the provider (never a global stub, unlike the stock
 * footage adapters — this class takes it as a constructor argument precisely so
 * a test can watch what was sent). Nothing here contacts fal.ai, and nothing
 * here needs a credential: every request the adapter builds is asserted against
 * the fake, not against a live queue.
 *
 * The assertion this file exists for is the last one: **a bogus request id
 * answers `200 {"status":"COMPLETED"}`**, measured against the real API. Any
 * pipeline that reads COMPLETED as proof a generation happened will happily
 * mark a job done and store nothing. `fetchResult` has to refuse it, so there
 * is a test that says so.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const KEY = "fal-test-key-not-a-real-one";

function request(
  overrides: Partial<VideoGenerationRequest> = {},
): VideoGenerationRequest {
  return {
    apiKey: KEY,
    model: DEFAULT_FAL_MODEL,
    prompt: "Medium shot of a man at a desk, slow push in, 35mm, shallow depth",
    negativePrompt: "text, watermark",
    aspectRatio: "9:16",
    durationSeconds: 5,
    seed: 100001,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  } as Response;
}

function binaryResponse(bytes: Buffer): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as Response;
}

describe("buildFalRequestBody", () => {
  it("sends the seed, because a re-roll of one clip depends on it", () => {
    expect(buildFalRequestBody(request()).seed).toBe(100001);
  });

  it("expresses length as num_frames for wan-t2v and as a duration string for veo3", () => {
    // The two models disagree about this field, and sending the wrong one is a
    // 422 after the job row exists rather than a bad clip.
    expect(buildFalRequestBody(request({ durationSeconds: 5 }))).toMatchObject({
      num_frames: 81,
    });
    expect(
      buildFalRequestBody(request({ model: "fal-ai/veo3", durationSeconds: 4.5 })),
    ).toMatchObject({ duration: "4s" });
    expect(
      buildFalRequestBody(request({ model: "fal-ai/veo3", durationSeconds: 4.5 })),
    ).not.toHaveProperty("num_frames");
  });

  it("omits negative_prompt entirely when there is none, rather than sending an empty string", () => {
    expect(buildFalRequestBody(request({ negativePrompt: undefined }))).not.toHaveProperty(
      "negative_prompt",
    );
  });

  it("refuses a model this app has no adapter shape for, before anything is sent", () => {
    // kling and minimax accept no seed at all, so render-manifest.ts's own gate
    // makes them unusable here. Naming one must fail loudly, not silently drop
    // the seed.
    expect(() =>
      buildFalRequestBody(request({ model: "fal-ai/kling-video/v1/standard/text-to-video" })),
    ).toThrow(ProviderError);
  });

  it("refuses an aspect ratio the model does not render", () => {
    expect(() => buildFalRequestBody(request({ aspectRatio: "1:1" }))).toThrow(
      /accepts 9:16 or 16:9/,
    );
  });
});

describe("wanFrameCount", () => {
  it("matches the one frame count actually measured", () => {
    expect(wanFrameCount(5)).toBe(81);
  });

  it("stays inside the band the format cuts at, whatever it is handed", () => {
    // MIN_CLIP_SECONDS 4 to MAX_CLIP_SECONDS 5, at this model's own 16fps.
    expect(wanFrameCount(4)).toBe(65);
    expect(wanFrameCount(0.5)).toBe(65);
    expect(wanFrameCount(40)).toBe(81);
  });
});

describe("nearestDurationChoice", () => {
  it("picks a length the model actually offers", () => {
    expect(nearestDurationChoice(4.5, ["4s", "6s", "8s"])).toBe("4s");
    expect(nearestDurationChoice(5.4, ["4s", "6s", "8s"])).toBe("6s");
  });
});

describe("FalVideoProvider.submit", () => {
  it("posts to the model's queue url with the Key auth header and returns the request id", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchClient = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ status: "IN_QUEUE", request_id: "req-1" });
    }) as unknown as typeof fetch;

    const id = await new FalVideoProvider(fetchClient).submit(request());

    expect(id).toBe("req-1");
    expect(calls[0].url).toBe(`https://queue.fal.run/${DEFAULT_FAL_MODEL}`);
    expect(calls[0].init?.method).toBe("POST");
    // `Key <token>`, not `Bearer` — without it every fal endpoint is a 401.
    expect(
      (calls[0].init?.headers as Record<string, string>).Authorization,
    ).toBe(`Key ${KEY}`);
    expect(JSON.parse(String(calls[0].init?.body)).seed).toBe(100001);
  });

  it("treats a 200 with no request id as retryable, because the generation may have started", async () => {
    const fetchClient = vi.fn(async () =>
      jsonResponse({ status: "IN_QUEUE" }),
    ) as unknown as typeof fetch;

    await expect(new FalVideoProvider(fetchClient).submit(request())).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("does not send anything at all when the body cannot be built", async () => {
    const fetchClient = vi.fn(async () =>
      jsonResponse({ request_id: "req-1" }),
    ) as unknown as typeof fetch;

    await expect(
      new FalVideoProvider(fetchClient).submit(request({ aspectRatio: "1:1" })),
    ).rejects.toThrow(ProviderError);
    expect(fetchClient).not.toHaveBeenCalled();
  });
});

describe("FalVideoProvider.checkStatus", () => {
  it("collapses IN_QUEUE and IN_PROGRESS into one PENDING state", async () => {
    for (const status of ["IN_QUEUE", "IN_PROGRESS"]) {
      const fetchClient = vi.fn(async () =>
        jsonResponse({ status }),
      ) as unknown as typeof fetch;

      await expect(
        new FalVideoProvider(fetchClient).checkStatus(DEFAULT_FAL_MODEL, "req-1", KEY),
      ).resolves.toMatchObject({ state: "PENDING" });
    }
  });

  it("reports COMPLETED and FAILED, carrying the provider's own words for the failure", async () => {
    const completed = vi.fn(async () =>
      jsonResponse({ status: "COMPLETED" }),
    ) as unknown as typeof fetch;
    const failed = vi.fn(async () =>
      jsonResponse({ status: "FAILED", error: "content policy" }),
    ) as unknown as typeof fetch;

    await expect(
      new FalVideoProvider(completed).checkStatus(DEFAULT_FAL_MODEL, "req-1", KEY),
    ).resolves.toMatchObject({ state: "COMPLETED" });
    await expect(
      new FalVideoProvider(failed).checkStatus(DEFAULT_FAL_MODEL, "req-1", KEY),
    ).resolves.toMatchObject({ state: "FAILED", detail: "content policy" });
  });

  it("reads an unfamiliar status as still running, so an unknown state is never paid for twice", async () => {
    const fetchClient = vi.fn(async () =>
      jsonResponse({ status: "THROTTLED" }),
    ) as unknown as typeof fetch;

    const result = await new FalVideoProvider(fetchClient).checkStatus(
      DEFAULT_FAL_MODEL,
      "req-1",
      KEY,
    );

    expect(result.state).toBe("PENDING");
    expect(result.detail).toContain("THROTTLED");
  });
});

describe("FalVideoProvider.fetchResult", () => {
  it("downloads the video from the result url without sending the key to it", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchClient = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });

      return String(url).startsWith("https://queue.fal.run")
        ? jsonResponse({
            video: { url: "https://cdn.fal.invalid/out.mp4", content_type: "video/mp4" },
            seed: 100001,
          })
        : binaryResponse(Buffer.from("mp4-bytes"));
    }) as unknown as typeof fetch;

    const clip = await new FalVideoProvider(fetchClient).fetchResult(
      DEFAULT_FAL_MODEL,
      "req-1",
      KEY,
    );

    expect(clip.data.toString()).toBe("mp4-bytes");
    expect(clip.contentType).toBe("video/mp4");
    // Reported back so the caller can prove the seed was honoured rather than
    // discovering it was not from twelve clips that all moved at once.
    expect(clip.seed).toBe(100001);
    // The CDN url is pre-signed. Sending the API key to it would leak the
    // credential to a host that is not the API.
    expect(calls[1].url).toBe("https://cdn.fal.invalid/out.mp4");
    expect(calls[1].init).toBeUndefined();
  });

  it("refuses a COMPLETED result that carries no video, because a bogus id answers COMPLETED too", async () => {
    // Measured against the real API: GET on a request id that never existed
    // returns 200 {"status":"COMPLETED"}. Treating that as success is how a
    // pipeline marks a job done and stores nothing.
    const fetchClient = vi.fn(async () =>
      jsonResponse({ status: "COMPLETED" }),
    ) as unknown as typeof fetch;

    await expect(
      new FalVideoProvider(fetchClient).fetchResult(DEFAULT_FAL_MODEL, "nope", KEY),
    ).rejects.toMatchObject({
      retryable: false,
      message: expect.stringContaining("returned no video"),
    });
  });
});

describe("FalVideoProvider.verifyKey", () => {
  it("asks about an id that cannot exist, so the check starts no generation", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchClient = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ status: "COMPLETED" });
    }) as unknown as typeof fetch;

    await expect(new FalVideoProvider(fetchClient).verifyKey(KEY)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/requests/00000000-0000-0000-0000-000000000000/status");
    expect(calls[0].init?.method).toBeUndefined();
  });

  it("is false for a rejected key and true for a 404, which still proves the key got through", async () => {
    const unauthorized = vi.fn(async () =>
      jsonResponse({}, 401),
    ) as unknown as typeof fetch;
    const notFound = vi.fn(async () => jsonResponse({}, 404)) as unknown as typeof fetch;

    await expect(new FalVideoProvider(unauthorized).verifyKey(KEY)).resolves.toBe(false);
    await expect(new FalVideoProvider(notFound).verifyKey(KEY)).resolves.toBe(true);
  });

  it("throws rather than blaming the key when fal itself is broken", async () => {
    const fetchClient = vi.fn(async () => jsonResponse({}, 503)) as unknown as typeof fetch;

    await expect(new FalVideoProvider(fetchClient).verifyKey(KEY)).rejects.toThrow(
      /says nothing about whether the key is valid/,
    );
  });
});
