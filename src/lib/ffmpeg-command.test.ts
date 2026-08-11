import { describe, expect, it } from "vitest";

import {
  buildAssembleArgs,
  buildSegmentArgs,
  concatListLine,
  planRender,
} from "@/lib/ffmpeg-command";

const assembleBase = {
  concatListPath: "/tmp/segments.txt",
  audioPath: "/tmp/narration.mp3",
  srtPath: "/tmp/captions.srt",
  outputPath: "/tmp/out.mp4",
  durationSeconds: 428,
};

/** Reads the value FFmpeg would see for a flag — the argument after it. */
function valueOf(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe("planRender", () => {
  it("normalises each distinct clip exactly once", () => {
    const sequence = ["/tmp/a.mp4", "/tmp/b.mp4", "/tmp/c.mp4"];
    const plan = planRender([...sequence, ...sequence, ...sequence], "/tmp");

    // The whole point: nine slots, three encodes. Opening a clip per slot is
    // what OOM-killed the worker.
    expect(plan.segments.map((s) => s.clipPath)).toEqual(sequence);
    expect(plan.playOrder).toHaveLength(9);
  });

  it("keeps the sequence's order, repeats pointing at the same segment", () => {
    const plan = planRender(["/tmp/a.mp4", "/tmp/b.mp4", "/tmp/a.mp4"], "/tmp");

    const [first, second, third] = plan.playOrder;
    expect(first).toBe(third);
    expect(second).not.toBe(first);
  });

  it("refuses to plan with no clips", () => {
    expect(() => planRender([], "/tmp")).toThrow();
  });
});

describe("concatListLine", () => {
  it("quotes a path so the demuxer reads it as one token", () => {
    expect(concatListLine("/tmp/my segment.mp4")).toBe("file '/tmp/my segment.mp4'");
  });

  it("escapes a quote in the path rather than ending the token early", () => {
    // A bare `'` would close the quote and leave the rest as garbage.
    expect(concatListLine("/tmp/it's.mp4")).toBe("file '/tmp/it'\\''s.mp4'");
  });
});

describe("buildSegmentArgs", () => {
  const base = { clipPath: "/tmp/a.mp4", outputPath: "/tmp/segment-0.mp4" };

  it("bounds the input so an infinite loop cannot decode forever", () => {
    const args = buildSegmentArgs({ ...base, clipSeconds: 12 });

    // -stream_loop -1 makes the input endless; the input-level -t is the only
    // thing that stops it, and it must come before -i to apply to the input.
    expect(args.indexOf("-stream_loop")).toBeLessThan(args.indexOf("-i"));
    expect(args.indexOf("-t")).toBeLessThan(args.indexOf("-i"));
    expect(valueOf(args, "-t")).toBe("12");
  });

  it("normalises to the frame size and rate the demuxer requires", () => {
    const filter = valueOf(buildSegmentArgs(base), "-vf") ?? "";

    // The concat demuxer joins without re-encoding, so segments that disagree
    // on any of these cannot be joined at all.
    expect(filter).toContain("scale=1920:1080");
    expect(filter).toContain("crop=1920:1080");
    expect(filter).toContain("fps=30");
    expect(filter).toContain("setsar=1");
  });

  it("drops the clip's own audio", () => {
    expect(buildSegmentArgs(base)).toContain("-an");
  });

  it("encodes finer than the final pass, since these frames get re-encoded", () => {
    const segmentCrf = Number(valueOf(buildSegmentArgs(base), "-crf"));
    const finalCrf = Number(valueOf(buildAssembleArgs(assembleBase), "-crf"));

    // Lower CRF is higher quality. Equal or worse here would compound
    // generational loss into the delivered video.
    expect(segmentCrf).toBeLessThan(finalCrf);
  });

  it("puts the output path last", () => {
    expect(buildSegmentArgs(base).at(-1)).toBe("/tmp/segment-0.mp4");
  });
});

describe("buildAssembleArgs", () => {
  it("joins with the concat demuxer, not the concat filter", () => {
    const args = buildAssembleArgs(assembleBase);

    // The filter holds every input open at once; the demuxer reads one file at
    // a time. That difference is the whole reason for two passes.
    expect(valueOf(args, "-f")).toBe("concat");
    expect(args.join(" ")).not.toContain("concat=n=");
  });

  it("allows the absolute paths the list actually contains", () => {
    // Without -safe 0 the demuxer rejects absolute paths outright.
    expect(valueOf(buildAssembleArgs(assembleBase), "-safe")).toBe("0");
  });

  it("maps the narration, not a segment, as the audio track", () => {
    const args = buildAssembleArgs(assembleBase);

    // Segments carry no audio at all, so input 1 is the only source.
    expect(args).toContain("1:a");
  });

  it("cuts the output to the narration's length", () => {
    const args = buildAssembleArgs(assembleBase);
    // The only -t here is the output one, unlike the segment pass.
    expect(valueOf(args, "-t")).toBe("428");
  });

  it("escapes a subtitle path containing special characters", () => {
    const args = buildAssembleArgs({ ...assembleBase, srtPath: "/tmp/my captions.srt" });
    // The filter graph parser must not break on the space.
    expect(args.join(" ")).toContain("my\\ captions.srt");
  });

  it("puts the output path last", () => {
    expect(buildAssembleArgs(assembleBase).at(-1)).toBe("/tmp/out.mp4");
  });
});
