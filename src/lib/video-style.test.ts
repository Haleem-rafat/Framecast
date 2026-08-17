import { describe, expect, it } from "vitest";

import { DEFAULT_STYLE } from "@/lib/video-style";

describe("DEFAULT_STYLE", () => {
  it("pans far enough to be visible but not so far the picture softens", () => {
    // The crop window is the full frame and the source is scaled by this
    // factor, so the pannable margin is (scale - 1) of the frame. Below ~1.05
    // the move is invisible; above ~1.3 the effective resolution drops enough
    // to see.
    expect(DEFAULT_STYLE.motion.scale).toBeGreaterThan(1.05);
    expect(DEFAULT_STYLE.motion.scale).toBeLessThanOrEqual(1.3);
  });

  it("keeps the music bed well under the narration", () => {
    expect(DEFAULT_STYLE.audio.musicGainDb).toBeLessThan(-12);
  });

  it("uses a transition short enough to read as a cut, not a dissolve", () => {
    expect(DEFAULT_STYLE.transitions.durationSeconds).toBeLessThanOrEqual(1);
    expect(DEFAULT_STYLE.transitions.durationSeconds).toBeGreaterThan(0);
  });

  it("pins a voice seed so an unchanged video re-renders identically", () => {
    expect(Number.isInteger(DEFAULT_STYLE.voice.seed)).toBe(true);
  });

  it("captions with SRT, so an unstyled channel renders as it always has", () => {
    // The default is the whole of the promise that kinetic captions are
    // additive: a channel with no brand row, and every channel styled before
    // this field existed, resolves to this and takes the `buildSrt` branch in
    // render.service.ts.
    expect(DEFAULT_STYLE.captionMode).toBe("srt");
  });
});
