import { describe, expect, it } from "vitest";

import { FRAME_SIZES } from "@/lib/ffmpeg-command";
import { SCRIPT_STYLES, scriptStylesUnder } from "@/lib/script-styles";
import {
  estimateSpokenSeconds,
  formatFit,
  formatRuntime,
  VERTICAL_HARD_LIMIT_SECONDS,
  VERTICAL_MAX_SECONDS,
  VIDEO_FORMATS,
  WORDS_PER_MINUTE,
} from "@/lib/video-format";

/**
 * The numbers an operator is shown at Gate 1, before a video costs anything.
 *
 * All of it is arithmetic over constants, so none of these need a database, a
 * model or an encoder. What they are protecting is the honesty of a dialog that
 * commits real spend: a resolution that disagrees with what FFmpeg produces, or
 * a nine-minute script quietly reported as fitting inside a Short, is a wrong
 * answer the operator has no other way to check.
 */
describe("VIDEO_FORMATS", () => {
  it("reports the resolution the renderer actually produces", () => {
    // Read from FRAME_SIZES rather than restated, so the label on the video
    // page cannot drift from the pixels in the file. Written out here because
    // a test that recomputes the value from the same source proves nothing.
    expect(VIDEO_FORMATS.LANDSCAPE.dimensions).toBe("1920×1080");
    expect(VIDEO_FORMATS.VERTICAL.dimensions).toBe("1080×1920");
    expect(FRAME_SIZES.LANDSCAPE).toEqual({ width: 1920, height: 1080 });
    expect(FRAME_SIZES.VERTICAL).toEqual({ width: 1080, height: 1920 });
  });

  it("caps only the vertical format", () => {
    // A full video is as long as its script. A Short is a Short because
    // YouTube says three minutes, which is a fact about the platform rather
    // than a preference this app holds.
    expect(VIDEO_FORMATS.LANDSCAPE.maxSeconds).toBeNull();
    expect(VIDEO_FORMATS.VERTICAL.maxSeconds).toBe(VERTICAL_MAX_SECONDS);
    expect(VERTICAL_MAX_SECONDS).toBe(180);
  });
});

describe("estimateSpokenSeconds", () => {
  it("uses the same reading pace every script prompt states to the model", () => {
    // 150 words a minute is written into every entry in the catalogue ("read
    // aloud at about 150 words a minute"). If the estimate shown before
    // approving used a different figure, the script would be written to one
    // length and judged against another.
    expect(WORDS_PER_MINUTE).toBe(150);
    expect(estimateSpokenSeconds(150)).toBe(60);
    expect(estimateSpokenSeconds(1350)).toBe(540);
  });

  it("reports nothing for a script with no words", () => {
    expect(estimateSpokenSeconds(0)).toBe(0);
    expect(estimateSpokenSeconds(-10)).toBe(0);
  });
});

describe("formatFit", () => {
  it("never refuses a full video, however long the script is", () => {
    expect(formatFit("LANDSCAPE", 5000).verdict).toBe("fits");
  });

  it("accepts a script that fits inside the Shorts ceiling", () => {
    const fit = formatFit("VERTICAL", 110);

    expect(fit.verdict).toBe("fits");
    expect(fit.estimatedSeconds).toBeCloseTo(44, 5);
  });

  it("warns about a script a little past the ceiling", () => {
    // Three and a half minutes: YouTube takes it, it is simply not in the
    // Shorts feed. A sentence, not a gate.
    expect(formatFit("VERTICAL", 525).verdict).toBe("over");
  });

  it("escalates a script that cannot be a Short by any reading", () => {
    // The case in the brief: a nine-minute script approved as a short. Nothing
    // in this pipeline shortens a script, so what the operator would get is a
    // nine-minute vertical video, paid for in full.
    const fit = formatFit("VERTICAL", 1350);

    expect(fit.verdict).toBe("far-over");
    expect(fit.estimatedSeconds).toBeGreaterThan(VERTICAL_HARD_LIMIT_SECONDS);
  });
});

describe("formatRuntime", () => {
  it("reads as minutes and seconds, which is what the limits are stated in", () => {
    expect(formatRuntime(0)).toBe("0:00");
    expect(formatRuntime(45)).toBe("0:45");
    expect(formatRuntime(540)).toBe("9:00");
    expect(formatRuntime(552.4)).toBe("9:12");
  });
});

describe("which catalogue styles suit which output", () => {
  it("offers at least one style a Short can be written with", () => {
    // Before `vertical-short` existed the answer was none of them, so choosing
    // the vertical output at Gate 1 could only ever produce a warning. The
    // advice in the approve dialog is generated from this list, so an empty one
    // would mean telling the operator to write a shorter script with nothing to
    // write it from.
    const suitable = scriptStylesUnder(VERTICAL_MAX_SECONDS);

    expect(suitable.length).toBeGreaterThan(0);
    expect(suitable.map((style) => style.id)).toContain("vertical-short");
  });

  it("keeps every long-form style out of that list", () => {
    const suitable = new Set(
      scriptStylesUnder(VERTICAL_MAX_SECONDS).map((style) => style.id),
    );

    expect(suitable.has("default-script")).toBe(false);
    expect(suitable.has("childrens-content")).toBe(false);
  });

  it("agrees with the duration each style actually asks the model for", () => {
    // `targetSeconds` is what the fit advice is computed from, so a style
    // retargeted in its prompt and not in its metadata would advertise a length
    // it does not write.
    for (const style of SCRIPT_STYLES) {
      const minutes = style.variables.find((variable) => variable.key === "duration");
      const seconds = style.variables.find((variable) => variable.key === "seconds");

      const declared = minutes
        ? Number(minutes.defaultValue) * 60
        : Number(seconds?.defaultValue);

      expect(declared, `${style.name} declares no length at all`).toBeGreaterThan(0);
      expect(
        style.targetSeconds,
        `${style.name} advertises ${style.targetSeconds}s but asks for ${declared}s`,
      ).toBe(declared);
    }
  });
});
