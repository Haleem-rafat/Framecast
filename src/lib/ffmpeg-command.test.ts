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

describe("buildSegmentArgs with motion", () => {
  const base = { clipPath: "/tmp/a.mp4", outputPath: "/tmp/segment-0.mp4", clipSeconds: 8 };
  const motion = { enabled: true, scale: 1.15 };

  it("scales past the frame so the crop window has room to travel", () => {
    const filter = valueOf(buildSegmentArgs({ ...base, index: 0, motion }), "-vf") ?? "";

    // 1920 * 1.15 = 2208, 1080 * 1.15 = 1242.
    expect(filter).toContain("scale=2208:1242");
    expect(filter).toContain("crop=2208:1242");
  });

  it("ends on a full-frame crop that moves with t", () => {
    const filter = valueOf(buildSegmentArgs({ ...base, index: 0, motion }), "-vf") ?? "";

    expect(filter).toContain("crop=w=1920:h=1080");
    expect(filter).toContain("t/8");
  });

  it("cycles direction by index so neighbours never move alike", () => {
    const filters = [0, 1, 2, 3, 4].map(
      (index) => valueOf(buildSegmentArgs({ ...base, index, motion }), "-vf") ?? "",
    );

    expect(filters[0]).not.toBe(filters[1]);
    expect(filters[1]).not.toBe(filters[2]);
    expect(filters[2]).not.toBe(filters[3]);
    // Four directions, so index 4 repeats index 0 — and a re-render of an
    // unchanged video must produce identical arguments.
    expect(filters[4]).toBe(filters[0]);
  });

  it("falls back to the plain normalising chain when motion is off", () => {
    const filter =
      valueOf(
        buildSegmentArgs({ ...base, index: 0, motion: { enabled: false, scale: 1.15 } }),
        "-vf",
      ) ?? "";

    expect(filter).toContain("scale=1920:1080");
    expect(filter).not.toContain("t/8");
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

describe("buildAssembleArgs with caption styling", () => {
  const captions = {
    fontName: "DejaVu Sans",
    fontSize: 22,
    primaryColour: "&H00FFFFFF",
    outlineColour: "&H00000000",
    outline: 2,
    shadow: 1,
    marginV: 60,
  };

  it("passes the chosen face and metrics to libass", () => {
    const joined = buildAssembleArgs({ ...assembleBase, captions }).join(" ");

    expect(joined).toContain("force_style=");
    expect(joined).toContain("FontName=DejaVu Sans");
    expect(joined).toContain("FontSize=22");
    expect(joined).toContain("MarginV=60");
  });

  it("still escapes the subtitle path when a style is present", () => {
    const args = buildAssembleArgs({
      ...assembleBase,
      srtPath: "/tmp/my captions.srt",
      captions,
    });

    expect(args.join(" ")).toContain("my\\ captions.srt");
  });

  it("omits force_style entirely when no style is given", () => {
    expect(buildAssembleArgs(assembleBase).join(" ")).not.toContain("force_style");
  });
});

describe("buildAssembleArgs audio chain", () => {
  const audio = {
    musicGainDb: -20,
    sfxGainDb: -8,
    duckThreshold: 0.03,
    duckRatio: 8,
    duckAttackMs: 20,
    duckReleaseMs: 300,
  };

  it("normalises the narration to the platform target", () => {
    const graph = valueOf(buildAssembleArgs({ ...assembleBase, audio }), "-filter_complex") ?? "";
    expect(graph).toContain("loudnorm=I=-14:TP=-1.5:LRA=11");
  });

  it("ducks the music under the narration", () => {
    const graph =
      valueOf(
        buildAssembleArgs({ ...assembleBase, audio, musicPath: "/tmp/music.mp3" }),
        "-filter_complex",
      ) ?? "";

    expect(graph).toContain("sidechaincompress");
    // The narration feeds both the mix and the ducking key, so it must split.
    expect(graph).toContain("asplit");
  });

  it("never lets amix renormalise the levels", () => {
    const graph =
      valueOf(
        buildAssembleArgs({ ...assembleBase, audio, musicPath: "/tmp/music.mp3" }),
        "-filter_complex",
      ) ?? "";

    // amix's default divides by input count, silently undoing the loudnorm
    // above it. This flag is the whole reason the mix holds its level.
    expect(graph).toContain("normalize=0");
  });

  it("loops the music and relies on -t to end the render", () => {
    const args = buildAssembleArgs({ ...assembleBase, audio, musicPath: "/tmp/music.mp3" });

    // -stream_loop makes that input infinite, so the output -t is what stops
    // ffmpeg. It must sit immediately before the music input.
    const loopIndex = args.indexOf("-stream_loop");
    expect(loopIndex).toBeGreaterThan(-1);
    expect(args[loopIndex + 2]).toBe("-i");
    expect(args[loopIndex + 3]).toBe("/tmp/music.mp3");
    expect(valueOf(args, "-t")).toBe("428");
  });

  it("mixes three streams when music and effects are both present", () => {
    const graph =
      valueOf(
        buildAssembleArgs({
          ...assembleBase,
          audio,
          musicPath: "/tmp/music.mp3",
          sfxPath: "/tmp/sfx.m4a",
        }),
        "-filter_complex",
      ) ?? "";

    expect(graph).toContain("amix=inputs=3");
  });

  it("maps narration straight through when there is neither music nor effects", () => {
    expect(buildAssembleArgs(assembleBase)).toContain("1:a");
  });
});
