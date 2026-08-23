import { describe, expect, it } from "vitest";

import { canReuseRender } from "@/lib/render-reuse";

const narrated = new Date("2026-08-23T10:00:00Z");

const succeeded = (finishedAt: Date) => ({
  status: "SUCCEEDED",
  outputUrl: "renders/abc.mp4",
  finishedAt,
});

describe("canReuseRender", () => {
  // The case this was written for: a publish failed, retry() reset the status
  // to QUEUED, and the finished MP4 is still on disk. Re-encoding it is
  // minutes of CPU to reproduce a file that already exists.
  it("keeps a render finished after the narration it plays", () => {
    expect(
      canReuseRender({
        latestRender: succeeded(new Date("2026-08-23T10:05:00Z")),
        narrationUpdatedAt: narrated,
        outputExists: true,
      }),
    ).toBe(true);
  });

  // The one thing that genuinely invalidates a render. runPipeline's own doc
  // comment sets out why: new narration rewrites the alignment, footage is
  // re-timed against it and the captions move.
  it("discards a render made before the current narration", () => {
    expect(
      canReuseRender({
        latestRender: succeeded(new Date("2026-08-23T09:55:00Z")),
        narrationUpdatedAt: narrated,
        outputExists: true,
      }),
    ).toBe(false);
  });

  // A row pointing at a file that has been cleaned up is a promise the
  // renderer cannot keep.
  it("discards a render whose file is gone", () => {
    expect(
      canReuseRender({
        latestRender: succeeded(new Date("2026-08-23T10:05:00Z")),
        narrationUpdatedAt: narrated,
        outputExists: false,
      }),
    ).toBe(false);
  });

  it("discards a render that did not succeed", () => {
    expect(
      canReuseRender({
        latestRender: { status: "FAILED", outputUrl: "renders/abc.mp4", finishedAt: new Date() },
        narrationUpdatedAt: narrated,
        outputExists: true,
      }),
    ).toBe(false);
  });

  it("discards a succeeded render that recorded no file", () => {
    expect(
      canReuseRender({
        latestRender: { status: "SUCCEEDED", outputUrl: null, finishedAt: new Date() },
        narrationUpdatedAt: narrated,
        outputExists: true,
      }),
    ).toBe(false);
  });

  it("renders from scratch when there has never been one", () => {
    expect(
      canReuseRender({ latestRender: null, narrationUpdatedAt: narrated, outputExists: false }),
    ).toBe(false);
  });

  // A contradiction rather than a case: a render cannot have been made without
  // narration. Refused rather than reasoned about — being wrong here costs one
  // re-encode, and being wrong the other way publishes a file nobody can
  // account for.
  it("refuses to reason about a render with no narration behind it", () => {
    expect(
      canReuseRender({
        latestRender: succeeded(new Date()),
        narrationUpdatedAt: null,
        outputExists: true,
      }),
    ).toBe(false);
  });

  // Same instant is reusable: the render cannot precede the narration it was
  // made from, so equality is the boundary of "current", not of "stale".
  it("keeps a render finished in the same instant as the narration", () => {
    expect(
      canReuseRender({
        latestRender: succeeded(narrated),
        narrationUpdatedAt: narrated,
        outputExists: true,
      }),
    ).toBe(true);
  });
});
