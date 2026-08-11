import { describe, expect, it } from "vitest";

import { buildSfxTrackArgs, planSfxCues } from "@/lib/sfx-track";

describe("planSfxCues", () => {
  it("never repeats a sound on adjacent boundaries", () => {
    const whooshes = planSfxCues([8, 16, 24, 32], 60).filter((cue) =>
      cue.path.includes("whoosh"),
    );

    expect(whooshes).toHaveLength(4);
    for (let index = 1; index < whooshes.length; index += 1) {
      expect(whooshes[index].path).not.toBe(whooshes[index - 1].path);
    }
  });

  it("opens with a stinger and closes with a swell", () => {
    const cues = planSfxCues([8], 60);

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
