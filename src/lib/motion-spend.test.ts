import { describe, expect, it } from "vitest";

import {
  DISPLAY_USD_PER_BILLED_SECOND,
  estimateUsd,
  MAX_BILLED_SECONDS_PER_VIDEO,
  planMotionSpend,
} from "@/lib/motion-spend";
import {
  billedSeconds,
  MAX_CLIP_SECONDS,
  MAX_CLIPS,
  MIN_CLIPS,
  type Manifest,
  type ManifestClip,
} from "@/lib/render-manifest";

/**
 * The ceiling, and the reason it is denominated in seconds.
 *
 * The assertions worth having here are not arithmetic — they are the two
 * relationships that make the number defensible. The ceiling must admit the
 * largest manifest `checkManifest` accepts (otherwise two gates disagree about
 * the same manifest), and it must refuse anything past it (otherwise it is
 * decoration).
 */

function clip(id: number, duration: number): ManifestClip {
  return {
    id,
    beat: "MECHANISM",
    start: 0,
    duration,
    narration: "Your brain keeps an open file for anything unfinished.",
    caption: "AN OPEN FILE",
    captionHighlight: "OPEN",
    emphasis: ["open"],
    cameraMove: "slow push in",
    prompt: "Medium shot of a man at a desk, slow push in",
    seed: 100001,
  };
}

function manifest(count: number, duration = MAX_CLIP_SECONDS): Manifest {
  return {
    conceptName: "The Zeigarnik effect",
    aspectRatio: "9:16",
    styleLock: "35mm, shallow depth of field",
    negativePrompt: "text, watermark",
    clips: Array.from({ length: count }, (_, index) => clip(index + 1, duration)),
  };
}

describe("MAX_BILLED_SECONDS_PER_VIDEO", () => {
  it("is exactly what the largest manifest checkManifest accepts costs", () => {
    // The derivation, restated as an assertion rather than a comment: if either
    // MAX_CLIPS or MAX_CLIP_SECONDS moves, this fails rather than silently
    // leaving a ceiling that no longer means "this format's maximum".
    expect(billedSeconds(manifest(MAX_CLIPS))).toBe(MAX_BILLED_SECONDS_PER_VIDEO);
    expect(MAX_BILLED_SECONDS_PER_VIDEO).toBe(96);
  });

  it("admits the largest legal manifest and refuses the one clip past it", () => {
    expect(planMotionSpend(manifest(MAX_CLIPS)).withinCeiling).toBe(true);
    // MAX_CLIPS + 1 is already refused by checkManifest; the point here is that
    // the ceiling refuses it too, so a caller that reached the spend gate with
    // an unvalidated manifest is still stopped.
    expect(planMotionSpend(manifest(MAX_CLIPS + 1)).withinCeiling).toBe(false);
  });

  it("leaves an ordinary manifest well clear of it", () => {
    const plan = planMotionSpend(manifest(MIN_CLIPS, 4.5));

    // 10 clips billed as 5s each, times the 1.6 reject rate.
    expect(plan.billedSeconds).toBe(80);
    expect(plan.withinCeiling).toBe(true);
  });
});

describe("planMotionSpend", () => {
  it("prices whole seconds, rounding a part-second clip up the way a model bills it", () => {
    // Eleven 4.1s clips are eleven 5s bills, not 45.1s of video.
    expect(planMotionSpend(manifest(11, 4.1)).billedSeconds).toBe(88);
  });

  it("honours a caller's own ceiling, so a tighter one can be imposed per video", () => {
    const plan = planMotionSpend(manifest(MIN_CLIPS, 4.5), 40);

    expect(plan.ceilingSeconds).toBe(40);
    expect(plan.withinCeiling).toBe(false);
    expect(plan.summary).toContain("against a ceiling of 40");
  });

  it("says in its own summary that the dollars are not the guard", () => {
    const plan = planMotionSpend(manifest(MIN_CLIPS, 4.5));

    // The estimate is shown, and it is shown labelled. An operator reading
    // "$4.00" with no qualifier would reasonably take it for a quote, and there
    // is no API anywhere that could make it one.
    expect(plan.estimatedUsd).toBe(estimateUsd(80));
    expect(plan.summary).toContain("unverified");
    expect(plan.summary).toContain("the seconds are the guard, not the dollars");
  });
});

describe("estimateUsd", () => {
  it("rounds to cents", () => {
    expect(estimateUsd(96)).toBe(
      Math.round(96 * DISPLAY_USD_PER_BILLED_SECOND * 100) / 100,
    );
    expect(estimateUsd(0)).toBe(0);
  });
});
