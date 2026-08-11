import { describe, expect, it } from "vitest";

import { buildSfxTrackArgs, MIN_WHOOSH_GAP_SECONDS, planSfxCues } from "@/lib/sfx-track";

/** Boundaries far enough apart that thinning keeps every one of them — what a
 *  test about something other than thinning wants to pass in. */
function spacedBoundaries(count: number): number[] {
  return Array.from(
    { length: count },
    (_boundary, index) => (index + 1) * MIN_WHOOSH_GAP_SECONDS,
  );
}

function whooshesOf(cues: { path: string }[]): { path: string }[] {
  return cues.filter((cue) => cue.path.includes("whoosh"));
}

describe("planSfxCues", () => {
  it("never repeats a sound on adjacent boundaries", () => {
    const boundaries = spacedBoundaries(4);
    const whooshes = whooshesOf(planSfxCues(boundaries, 300));

    expect(whooshes).toHaveLength(4);
    for (let index = 1; index < whooshes.length; index += 1) {
      expect(whooshes[index].path).not.toBe(whooshes[index - 1].path);
    }
  });

  it("opens with a stinger and closes with a swell", () => {
    const cues = planSfxCues([40], 60);

    expect(cues[0].atSeconds).toBe(0);
    expect(cues[0].path).toContain("stinger");
    expect(cues.at(-1)?.path).toContain("swell");
  });

  it("keeps the closing swell inside the video", () => {
    const cues = planSfxCues([], 2);
    const swell = cues.at(-1)!;

    // A three-second lead-in cannot start before zero on a two-second video.
    expect(swell.atSeconds).toBeGreaterThanOrEqual(0);
  });

  it("is deterministic for the same input", () => {
    expect(planSfxCues([8, 16], 60)).toEqual(planSfxCues([8, 16], 60));
  });
});

describe("planSfxCues — thinning", () => {
  /** A real seven-minute video cut per script section: a boundary roughly
   *  every eight seconds, which is what turned the whoosh from an accent into
   *  a metronome. */
  const perSectionBoundaries = Array.from(
    { length: 49 },
    (_boundary, index) => (index + 1) * 8.5,
  );

  it("does not lay a whoosh on every cut of a per-section video", () => {
    const whooshes = whooshesOf(planSfxCues(perSectionBoundaries, 7 * 60));

    // Forty-nine was the behaviour nobody chose; the twelve-clip version this
    // effect was designed against produced eleven.
    expect(whooshes.length).toBeLessThanOrEqual(14);
    expect(whooshes.length).toBeGreaterThan(0);
  });

  it("leaves at least the minimum gap between consecutive whooshes", () => {
    const whooshes = planSfxCues(perSectionBoundaries, 7 * 60).filter((cue) =>
      cue.path.includes("whoosh"),
    );

    for (let index = 1; index < whooshes.length; index += 1) {
      expect(whooshes[index].atSeconds - whooshes[index - 1].atSeconds).
        toBeGreaterThanOrEqual(MIN_WHOOSH_GAP_SECONDS);
    }
  });

  it("keeps the opening stinger clear of the first whoosh", () => {
    // The stinger is an effect the viewer hears at 0. A whoosh a few seconds
    // later reads as part of it rather than as a new accent, so the gap is
    // measured from the stinger and not from the first boundary.
    const whooshes = whooshesOf(planSfxCues([3, 6, 9], 60));

    expect(whooshes).toHaveLength(0);
  });

  it("still lands every surviving whoosh on a real cut", () => {
    const boundaries = [0.5, 12, 31, 33, 62];
    const whooshes = planSfxCues(boundaries, 120).filter((cue) =>
      cue.path.includes("whoosh"),
    );

    // Thinning may only ever drop effects. Inventing one where the picture
    // does not cut would be a whoosh over a continuous shot.
    for (const whoosh of whooshes) {
      expect(boundaries).toContain(whoosh.atSeconds);
    }
    expect(whooshes.map((cue) => cue.atSeconds)).toEqual([31, 62]);
  });

  it("keeps rotating sounds across the boundaries it kept, not the ones it saw", () => {
    // Every third boundary survives here. Rotating on the input index would
    // hand back whoosh-1 each time; rotating on the kept count is what keeps
    // two audible whooshes in a row from being the same file.
    const boundaries = Array.from(
      { length: 12 },
      (_boundary, index) => (index + 1) * 10,
    );
    const whooshes = whooshesOf(planSfxCues(boundaries, 200));

    expect(whooshes.length).toBeGreaterThan(2);
    for (let index = 1; index < whooshes.length; index += 1) {
      expect(whooshes[index].path).not.toBe(whooshes[index - 1].path);
    }
  });
});

describe("buildSfxTrackArgs", () => {
  it("delays each effect to its cue and mixes them into one track", () => {
    const args = buildSfxTrackArgs({
      cues: [
        { path: "/tmp/a.mp3", atSeconds: 0 },
        { path: "/tmp/b.mp3", atSeconds: 8 },
      ],
      durationSeconds: 60,
      outputPath: "/tmp/sfx.m4a",
    });

    const graph = args[args.indexOf("-filter_complex") + 1];

    // adelay takes milliseconds, and `all=1` applies the delay to every
    // channel rather than only the first.
    expect(graph).toContain("adelay=8000:all=1");
    expect(graph).toContain("amix=inputs=2");
    // Same reason as the assemble pass: amix's default would divide by input
    // count and quietly drop every effect's level.
    expect(graph).toContain("normalize=0");
  });

  it("opens one input per cue and writes the output last", () => {
    const args = buildSfxTrackArgs({
      cues: [
        { path: "/tmp/a.mp3", atSeconds: 0 },
        { path: "/tmp/b.mp3", atSeconds: 8 },
        { path: "/tmp/c.mp3", atSeconds: 20 },
      ],
      durationSeconds: 60,
      outputPath: "/tmp/sfx.m4a",
    });

    expect(args.filter((arg) => arg === "-i")).toHaveLength(3);
    expect(args.at(-1)).toBe("/tmp/sfx.m4a");
  });
});
