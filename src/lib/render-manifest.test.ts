import { describe, expect, it } from "vitest";

import {
  billedSeconds,
  checkManifest,
  clipPrompt,
  MAX_PROMPT_WORDS,
  type Manifest,
  type ManifestClip,
} from "@/lib/render-manifest";

/**
 * The gate that runs before a billed second.
 *
 * Generated clips cost dollars where stills cost cents, so every check here is
 * one that would otherwise be discovered after the money was spent. The
 * assertions are about the failures this format actually has: a prompt that
 * asks the model to draw the caption, two camera moves in one shot, a seed
 * that makes one bad clip un-rerollable.
 */

const STYLE_LOCK =
  "35mm, f/2.0, shallow depth of field, desaturated cool grade with warm skin " +
  "tones, cinematic documentary, soft single-source key light";

/** A prompt of a legal length that names exactly one allowed move. */
function prompt(move = "slow push in"): string {
  const filler = Array.from({ length: 44 }, (_, i) => `word${i}`).join(" ");

  return `Medium shot of a man ${filler} ${move}`;
}

function clip(overrides: Partial<ManifestClip> & { id: number }): ManifestClip {
  return {
    beat: "MECHANISM",
    start: 0,
    duration: 4.5,
    narration: "Your brain keeps an open file for anything unfinished.",
    caption: "AN OPEN FILE",
    captionHighlight: "OPEN",
    emphasis: ["open"],
    cameraMove: "slow push in",
    prompt: prompt(),
    seed: 100001,
    ...overrides,
  };
}

/** Eleven clips, six beats in order, and a total that matches its own words. */
function manifest(): Manifest {
  const beats = [
    "HOOK",
    "HOOK",
    "TENSION",
    "TENSION",
    "MECHANISM",
    "MECHANISM",
    "MECHANISM",
    "NAME_IT",
    "TURN",
    "TURN",
    "LOOP",
  ];

  // The fixture has to satisfy its own drift check, which is the point of that
  // check: 11 clips x 4.5s = 49.5s declared, so the narration must take about
  // the same to say. 12 words x 11 clips = 132 words, and 132 / 2.6 = 50.8s —
  // 1.3s apart, inside the 2s tolerance. Eleven words per clip drifts by 3.0s
  // and the baseline fails, which is how this comment came to exist.
  const narration = "Your brain keeps an open file for anything you left unfinished today";

  return {
    conceptName: "Zeigarnik effect",
    aspectRatio: "9:16",
    styleLock: STYLE_LOCK,
    negativePrompt: "text, watermark, logo, deformed face",
    clips: beats.map((beat, index) =>
      clip({ id: index + 1, beat, narration, start: index * 4.5 }),
    ),
  };
}

describe("checkManifest", () => {
  it("passes a manifest that follows the format", () => {
    const result = checkManifest(manifest());

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("refuses too few or too many clips", () => {
    const few = manifest();
    few.clips = few.clips.slice(0, 5);

    expect(checkManifest(few).errors.join(" ")).toMatch(/5 clips/);
  });

  it("refuses a clip too short to complete its camera move", () => {
    const short = manifest();
    short.clips[3].duration = 2;

    expect(checkManifest(short).errors.join(" ")).toMatch(/Clip 4 is 2s/);
  });

  it("refuses a prompt that asks the model to draw the caption", () => {
    // The expensive failure: burned-in text cannot be removed, cannot be
    // restyled, and sits under the real caption for the whole clip.
    for (const banned of ["text", "subtitle", "logo", "sign", "screen"]) {
      const bad = manifest();
      bad.clips[2].prompt = `${prompt()} with a ${banned} behind her`;

      expect(checkManifest(bad).ok, `"${banned}" was not caught`).toBe(false);
    }
  });

  it("does not fire on a word that merely contains a banned one", () => {
    // "screen" must not match "screenwriter", "sign" must not match "designer".
    const fine = manifest();
    fine.clips[2].prompt = prompt().replace("a man", "a screenwriter");

    expect(checkManifest(fine).ok).toBe(true);
  });

  it("refuses a camera move that is not on the list", () => {
    const bad = manifest();
    bad.clips[1].cameraMove = "drone orbit";
    bad.clips[1].prompt = prompt("drone orbit");

    expect(checkManifest(bad).errors.join(" ")).toMatch(/drone orbit/);
  });

  it("refuses a prompt naming two camera moves", () => {
    // A model given two picks one, and which one is not predictable.
    const bad = manifest();
    bad.clips[1].prompt = `${prompt("slow push in")} then slow drift left`;

    expect(checkManifest(bad).errors.join(" ")).toMatch(/names 2 camera moves/);
  });

  it("refuses a prompt outside the length band", () => {
    const long = manifest();
    long.clips[0].prompt = Array.from(
      { length: MAX_PROMPT_WORDS + 5 },
      () => "word",
    ).join(" ") + " slow push in";

    expect(checkManifest(long).errors.join(" ")).toMatch(/prompt is \d+ words/);
  });

  it("refuses a highlight that is not in its own caption", () => {
    const bad = manifest();
    bad.clips[0].captionHighlight = "MISSING";

    expect(checkManifest(bad).errors.join(" ")).toMatch(/MISSING/);
  });

  it("refuses a clip with no usable seed", () => {
    // Without a seed, fixing one bad clip means re-rolling all eleven.
    const bad = manifest();
    bad.clips[6].seed = Number.NaN;

    expect(checkManifest(bad).errors.join(" ")).toMatch(/no usable seed/);
  });

  it("refuses beats that run out of order", () => {
    const bad = manifest();
    bad.clips[9].beat = "HOOK";

    expect(checkManifest(bad).errors.join(" ")).toMatch(/in order/);
  });

  it("catches a manifest whose clips do not match its own narration", () => {
    // Internally consistent and still wrong: the picture would run ahead of
    // the words and nothing downstream would notice.
    const drift = manifest();
    for (const entry of drift.clips) entry.narration = "Two words";

    expect(checkManifest(drift).errors.join(" ")).toMatch(/takes about/);
  });

  it("writes errors a model can act on", () => {
    const bad = manifest();
    bad.clips[0].duration = 9;

    for (const error of checkManifest(bad).errors) {
      expect(error.trim()).toMatch(/\.$/);
      expect(error.length).toBeGreaterThan(20);
    }
  });
});

describe("clipPrompt", () => {
  it("appends the style lock in code, identically on every clip", () => {
    // The commonest failure of the genre is a video that looks like twelve
    // different films. Leaving the look to the model means eleven paraphrases
    // of it.
    const m = manifest();
    const locks = m.clips.map((c) => clipPrompt(m, c).slice(-STYLE_LOCK.length));

    expect(new Set(locks).size).toBe(1);
    expect(locks[0]).toBe(STYLE_LOCK);
  });
});

describe("billedSeconds", () => {
  it("rounds each clip up, because models bill whole seconds", () => {
    const m = manifest();
    m.clips = [clip({ id: 1, duration: 4.5 }), clip({ id: 2, duration: 4.1 })];

    // 5 + 5 = 10, before rejects.
    expect(billedSeconds(m, 1)).toBe(10);
  });

  it("counts the rejects, because generation does not succeed first time", () => {
    const m = manifest();
    m.clips = [clip({ id: 1, duration: 4.5 })];

    expect(billedSeconds(m, 1.6)).toBe(8);
  });
});
