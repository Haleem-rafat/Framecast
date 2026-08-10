import { describe, expect, it } from "vitest";

import { buildRenderArgs } from "@/lib/ffmpeg-command";

const base = {
  clipPaths: ["/tmp/a.mp4", "/tmp/b.mp4"],
  audioPath: "/tmp/narration.mp3",
  srtPath: "/tmp/captions.srt",
  outputPath: "/tmp/out.mp4",
  durationSeconds: 30,
};

describe("buildRenderArgs", () => {
  it("includes every clip as an input", () => {
    const args = buildRenderArgs(base);
    expect(args.filter((a) => a === "-i")).toHaveLength(3); // 2 clips + audio
  });

  it("cuts the output to the narration duration", () => {
    const args = buildRenderArgs(base);
    // There is now one `-t` per looped input plus the output's — indexOf
    // would find a per-clip one, not the output bound this test cares about.
    // The output `-t` is pushed last, so lastIndexOf always finds it.
    const lastT = args.lastIndexOf("-t");
    expect(lastT).toBeGreaterThan(-1);
    expect(args[lastT + 1]).toBe("30");
  });

  it("bounds every looped input to clipSeconds, so an infinite -stream_loop can't grow memory without limit", () => {
    const args = buildRenderArgs(base);

    // One "-t <clipSeconds>" immediately before each "-i <clip>", plus the
    // output's own "-t <duration>" at the end: base has 2 clips, so 3 "-t"
    // occurrences in total.
    const tIndexes = args.reduce<number[]>((acc, arg, i) => {
      if (arg === "-t") acc.push(i);
      return acc;
    }, []);
    expect(tIndexes).toHaveLength(base.clipPaths.length + 1);

    for (const clip of base.clipPaths) {
      const clipIndex = args.indexOf(clip);
      expect(args[clipIndex - 1]).toBe("-i");
      expect(args[clipIndex - 2]).toBe("12"); // DEFAULT_CLIP_SECONDS
      expect(args[clipIndex - 3]).toBe("-t");
    }
  });

  it("burns in the subtitle file", () => {
    expect(buildRenderArgs(base).join(" ")).toContain("subtitles=");
  });

  it("encodes h264 and aac", () => {
    const args = buildRenderArgs(base).join(" ");
    expect(args).toContain("libx264");
    expect(args).toContain("aac");
  });

  it("emits machine-readable progress", () => {
    const args = buildRenderArgs(base);
    expect(args).toContain("-progress");
  });

  it("puts the output path last", () => {
    expect(buildRenderArgs(base).at(-1)).toBe("/tmp/out.mp4");
  });

  it("refuses to build with no clips", () => {
    expect(() => buildRenderArgs({ ...base, clipPaths: [] })).toThrow();
  });

  it("escapes a subtitle path containing special characters", () => {
    const args = buildRenderArgs({ ...base, srtPath: "/tmp/my captions.srt" });
    // The filter graph must not break on the space.
    expect(args.join(" ")).toContain("my\\ captions.srt");
  });
});
