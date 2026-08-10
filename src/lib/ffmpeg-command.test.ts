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

  // The OOM that killed every render on the worker: RenderService repeats the
  // clip sequence to cover the narration, and each repeat used to become its
  // own input with its own decoder. Twelve clips over a 7-minute narration
  // meant 36 live decoders in a 1GB container.
  it("opens each distinct clip once however often the sequence repeats it", () => {
    const sequence = ["/tmp/a.mp4", "/tmp/b.mp4", "/tmp/c.mp4"];
    const args = buildRenderArgs({
      ...base,
      // The same three clips, three times over — what a long narration asks for.
      clipPaths: [...sequence, ...sequence, ...sequence],
    });

    const videoInputs = args.filter(
      (arg, index) => args[index - 1] === "-i" && arg !== "/tmp/narration.mp3",
    );

    expect(videoInputs).toEqual(sequence);
  });

  it("still shows every repeat, in the order asked for", () => {
    const args = buildRenderArgs({
      ...base,
      clipPaths: ["/tmp/a.mp4", "/tmp/b.mp4", "/tmp/a.mp4"],
    });
    const filter = args[args.indexOf("-filter_complex") + 1];

    // a.mp4 is input 0 and used twice, so it splits into two labels; b.mp4 is
    // used once and needs no split.
    expect(filter).toContain("split=2[v0_0][v0_1]");
    expect(filter).not.toContain("split=1");

    // Concat consumes them in the sequence's own order: a, b, a.
    expect(filter).toContain("[v0_0][v1_0][v0_1]concat=n=3");
  });

  it("points the audio map at the narration, not a clip", () => {
    const args = buildRenderArgs({
      ...base,
      clipPaths: ["/tmp/a.mp4", "/tmp/a.mp4", "/tmp/a.mp4"],
    });

    // One unique clip means narration is input 1 — if the audio index were
    // still derived from the sequence length it would point at input 3.
    expect(args).toContain("1:a");
  });
});
