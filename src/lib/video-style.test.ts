import { describe, expect, it } from "vitest";

import { DEFAULT_STYLE, styleBaseFor } from "@/lib/video-style";

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

describe("styleBaseFor", () => {
  // The measurement this exists for is in ffmpeg-command.ts — at scale 1.15
  // the crop window travels 0.48px a frame and the picture is frozen for
  // 75.7% of adjacent frame pairs. On a photograph that judder hides; on a
  // thick black line against pale paper it is exactly where the eye is.
  it("turns motion off for a doodle channel", () => {
    expect(styleBaseFor("DOODLE").motion.enabled).toBe(false);
  });

  // Caught by the first real render: 43 pictures, 42 joins, and ffmpeg found
  // zero hard cuts because every one of them was a half-second dissolve.
  it("cuts hard for a doodle channel rather than dissolving", () => {
    expect(styleBaseFor("DOODLE").transitions.enabled).toBe(false);
  });

  it("leaves every other style panning as it always did", () => {
    expect(styleBaseFor("ILLUSTRATED").motion.enabled).toBe(true);
    expect(styleBaseFor("ILLUSTRATED").transitions.enabled).toBe(true);
    expect(styleBaseFor("CINEMATIC").motion.enabled).toBe(true);
    expect(styleBaseFor("LIVE_ACTION").motion.enabled).toBe(true);
    expect(styleBaseFor(null).motion.enabled).toBe(true);
  });

  // Only the one field moves. A format default that quietly reset the caption
  // colour or the music gain would be a second, invisible style system.
  it("changes nothing else about the style", () => {
    const doodle = styleBaseFor("DOODLE");

    expect(doodle.captions).toEqual(DEFAULT_STYLE.captions);
    expect(doodle.audio).toEqual(DEFAULT_STYLE.audio);
    expect(doodle.transitions.durationSeconds).toBe(DEFAULT_STYLE.transitions.durationSeconds);
    expect(doodle.voice).toEqual(DEFAULT_STYLE.voice);
    expect(doodle.captionMode).toBe(DEFAULT_STYLE.captionMode);
    expect(doodle.motion.scale).toBe(DEFAULT_STYLE.motion.scale);
  });

  // Callers merge a stored style over this and mutate the result field by
  // field, so handing out a shared object would let one channel's saved style
  // leak into the next channel's render.
  it("returns a fresh object each time", () => {
    const first = styleBaseFor("DOODLE");
    first.motion.enabled = true;

    expect(styleBaseFor("DOODLE").motion.enabled).toBe(false);
  });
});
