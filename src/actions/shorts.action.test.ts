import { beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_SHORT_COUNT } from "@/schemas/video.schema";

/**
 * The count the browser sends, checked at the boundary it arrives at.
 *
 * `shorts.service.test.ts` proves what `generate` does with a count. This file
 * proves the action never lets one through unchecked — which is a different
 * claim, and the one that matters here: the count decides how many model calls
 * and how many worker encodes a single click buys, and it arrives from a page
 * anybody can edit. A bound that lived only in the panel would be a bound.
 *
 * Everything below the action is mocked, deliberately. There is no database
 * here because there is nothing to look up: an out-of-bounds count must be
 * refused before a video is even read, and the way to assert "before" is to
 * assert that the service was never called at all.
 */
const generateMock = vi.fn();
const listMock = vi.fn();

vi.mock("@/server/session", () => ({
  requireSession: async () => ({ user: { id: "user-under-test" } }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/services/shorts.service", () => ({
  shortsService: { generate: generateMock, list: listMock },
}));

const { generateShortsAction } = await import("@/actions/shorts.action");

const VIDEO_ID = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  generateMock.mockReset();
  generateMock.mockResolvedValue([]);
});

describe("generateShortsAction — the count", () => {
  it("passes a count the operator picked straight through", async () => {
    const result = await generateShortsAction(VIDEO_ID, 7);

    expect(result.ok).toBe(true);
    expect(generateMock).toHaveBeenCalledWith("user-under-test", VIDEO_ID, 7);
  });

  it("passes undefined when no count was given, rather than a number of its own", async () => {
    await generateShortsAction(VIDEO_ID);

    // Not `3`. The default is `shortsService.generate`'s own parameter, and an
    // action that filled it in here would be a second place the answer to "how
    // many shorts is one click" lives — free to drift from the first.
    expect(generateMock).toHaveBeenCalledWith("user-under-test", VIDEO_ID, undefined);
  });

  it("accepts the ceiling itself", async () => {
    const result = await generateShortsAction(VIDEO_ID, MAX_SHORT_COUNT);

    expect(result.ok).toBe(true);
    expect(generateMock).toHaveBeenCalledWith(
      "user-under-test",
      VIDEO_ID,
      MAX_SHORT_COUNT,
    );
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["past the ceiling", MAX_SHORT_COUNT + 1],
    ["far past the ceiling", 5000],
    ["fractional", 3.5],
    ["not a number at all", Number.NaN],
  ])("refuses a count that is %s, without calling the service", async (_label, count) => {
    const result = await generateShortsAction(VIDEO_ID, count);

    expect(result.ok).toBe(false);
    // The refusal has to come before the work, not instead of finishing it:
    // `generate` deletes the video's existing shorts and spends a model call,
    // and neither is undoable by returning an error afterwards.
    expect(generateMock).not.toHaveBeenCalled();
  });
});
