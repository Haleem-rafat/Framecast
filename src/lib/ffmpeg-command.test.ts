import { describe, expect, it } from "vitest";

import {
  buildAssembleArgs,
  buildSegmentArgs,
  buildShortArgs,
  buildTransitionArgs,
  concatListLine,
  planRender,
} from "@/lib/ffmpeg-command";
import { verticalCaptionStyle } from "@/lib/shorts-plan";
import { DEFAULT_STYLE } from "@/lib/video-style";

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

/** A duration list of `count` equal slots — what a caller with no per-section
 *  timing to offer (the tests below that are about something else entirely)
 *  would pass. */
function evenDurations(count: number, seconds: number): number[] {
  return Array.from({ length: count }, () => seconds);
}

describe("planRender", () => {
  it("normalises each distinct clip exactly once", () => {
    const sequence = ["/tmp/a.mp4", "/tmp/b.mp4", "/tmp/c.mp4"];
    const paths = [...sequence, ...sequence, ...sequence];
    const plan = planRender(paths, "/tmp", evenDurations(paths.length, 12));

    // The whole point: nine slots, three encodes. Opening a clip per slot is
    // what OOM-killed the worker.
    expect(plan.segments.map((s) => s.clipPath)).toEqual(sequence);
    expect(plan.playOrder).toHaveLength(9);
  });

  it("keeps the sequence's order, repeats pointing at the same segment", () => {
    const plan = planRender(
      ["/tmp/a.mp4", "/tmp/b.mp4", "/tmp/a.mp4"],
      "/tmp",
      evenDurations(3, 12),
    );

    const [first, second, third] = plan.playOrder;
    expect(first).toBe(third);
    expect(second).not.toBe(first);
  });

  it("refuses to plan with no clips", () => {
    expect(() => planRender([], "/tmp", [])).toThrow();
  });
});

describe("planRender with per-section durations", () => {
  it("gives each segment its own duration", () => {
    const plan = planRender(["/tmp/a.mp4", "/tmp/b.mp4"], "/tmp", [7.5, 11.25]);

    expect(plan.segments.map((s) => s.clipSeconds)).toEqual([7.5, 11.25]);
  });

  it("refuses a duration list that does not match the clips", () => {
    // A mismatch means picture and narration would drift apart silently,
    // which is worse than refusing to render.
    expect(() => planRender(["/tmp/a.mp4"], "/tmp", [7.5, 11.25])).toThrow();
  });

  it("refuses a duration that FFmpeg could not honour", () => {
    // `-t 0` produces an empty segment and `-t NaN` an outright error; either
    // way the sections after it play against the wrong words. A duration this
    // shape can only come from a bug upstream, so it stops here.
    expect(() => planRender(["/tmp/a.mp4"], "/tmp", [0])).toThrow();
    expect(() => planRender(["/tmp/a.mp4"], "/tmp", [Number.NaN])).toThrow();
    expect(() => planRender(["/tmp/a.mp4"], "/tmp", [-2])).toThrow();
  });

  it("keeps the same clip at two different lengths apart", () => {
    // One clip, two sections of different lengths: the shorter segment must
    // not be reused for the longer slot, which would truncate it.
    const plan = planRender(["/tmp/a.mp4", "/tmp/a.mp4"], "/tmp", [4, 9]);

    expect(plan.segments).toHaveLength(2);
    expect(plan.playOrder[0]).not.toBe(plan.playOrder[1]);
  });
});

describe("planRender with transitions", () => {
  const transitions = { enabled: true, durationSeconds: 0.5 };

  it("puts one stub between each adjacent pair", () => {
    const plan = planRender(
      ["/tmp/a.mp4", "/tmp/b.mp4", "/tmp/c.mp4"],
      "/tmp",
      evenDurations(3, 8),
      transitions,
    );
    expect(plan.transitions).toHaveLength(2);
  });

  it("preserves the total duration exactly", () => {
    const clipSeconds = 8;
    const paths = ["/tmp/a.mp4", "/tmp/b.mp4", "/tmp/c.mp4", "/tmp/d.mp4"];
    const plan = planRender(
      paths,
      "/tmp",
      evenDurations(paths.length, clipSeconds),
      transitions,
    );

    // Every crossfade consumes D seconds of overlap, so a naive version comes
    // out D x boundaries short and drifts the picture off the narration.
    const segmentTotal = plan.trimmedSeconds.reduce((sum, seconds) => sum + seconds, 0);
    const stubTotal = plan.transitions.length * transitions.durationSeconds;

    expect(segmentTotal + stubTotal).toBeCloseTo(paths.length * clipSeconds, 5);
  });

  it("preserves the total when every section has its own length", () => {
    // The two features together: a crossfade still costs its overlap at every
    // boundary, but the slots it sits between are now all different sizes.
    // What must survive is the sum — that is what keeps the picture on the
    // narration it was cut against.
    const durations = [3.25, 9, 4.5, 12.75];
    const paths = ["/tmp/a.mp4", "/tmp/b.mp4", "/tmp/c.mp4", "/tmp/d.mp4"];
    const plan = planRender(paths, "/tmp", durations, transitions);

    const segmentTotal = plan.trimmedSeconds.reduce((sum, seconds) => sum + seconds, 0);
    const stubTotal = plan.transitions.length * transitions.durationSeconds;
    const expected = durations.reduce((sum, seconds) => sum + seconds, 0);

    expect(segmentTotal + stubTotal).toBeCloseTo(expected, 5);
  });

  it("asks for extra source on every segment but the last", () => {
    const plan = planRender(
      ["/tmp/a.mp4", "/tmp/b.mp4"],
      "/tmp",
      evenDurations(2, 8),
      transitions,
    );

    expect(plan.segments[0].clipSeconds).toBeCloseTo(8.5, 5);
    expect(plan.segments[1].clipSeconds).toBeCloseTo(8, 5);
  });

  it("trims the head and tail a stub already covers", () => {
    const plan = planRender(
      ["/tmp/a.mp4", "/tmp/b.mp4", "/tmp/c.mp4"],
      "/tmp",
      evenDurations(3, 8),
      transitions,
    );

    expect(plan.trims[0]).toEqual({ inpoint: undefined, outpoint: 8 });
    expect(plan.trims[1]).toEqual({ inpoint: 0.5, outpoint: 8 });
    expect(plan.trims[2]).toEqual({ inpoint: 0.5, outpoint: undefined });
  });

  it("trims each section against its own length, not a shared one", () => {
    // The outpoint is the section's own duration, so a stub always starts
    // where that section's words end rather than at a fixed offset.
    const plan = planRender(
      ["/tmp/a.mp4", "/tmp/b.mp4", "/tmp/c.mp4"],
      "/tmp",
      [6, 10, 4],
      transitions,
    );

    expect(plan.trims[0]).toEqual({ inpoint: undefined, outpoint: 6 });
    expect(plan.trims[1]).toEqual({ inpoint: 0.5, outpoint: 10 });
    expect(plan.trims[2]).toEqual({ inpoint: 0.5, outpoint: undefined });
  });

  it("refuses a section too short to host the crossfade it must donate to", () => {
    // A section shorter than the overlap would come out with an outpoint
    // before its inpoint — a concat list the demuxer reads as a negative
    // range, which is how a render produces a silently mistimed video rather
    // than an error.
    expect(() =>
      planRender(["/tmp/a.mp4", "/tmp/b.mp4"], "/tmp", [0.25, 8], transitions),
    ).toThrow();
  });

  it("plans no transitions for a single segment", () => {
    const plan = planRender(["/tmp/a.mp4"], "/tmp", [8], transitions);
    expect(plan.transitions).toHaveLength(0);
  });

  it("plans no transitions when they are disabled", () => {
    const plan = planRender(["/tmp/a.mp4", "/tmp/b.mp4"], "/tmp", evenDurations(2, 8), {
      enabled: false,
      durationSeconds: 0.5,
    });

    expect(plan.transitions).toHaveLength(0);
  });

  it("allows a section shorter than the crossfade when transitions are off", () => {
    // Nothing donates a tail, so the short-section rule above has nothing to
    // protect — and refusing here would fail renders that are perfectly fine.
    const plan = planRender(["/tmp/a.mp4", "/tmp/b.mp4"], "/tmp", [0.25, 8]);

    expect(plan.trimmedSeconds).toEqual([0.25, 8]);
  });
});

describe("concatListLine with a trim", () => {
  it("emits the demuxer's own in/out directives after the file line", () => {
    const line = concatListLine("/tmp/segment-1.mp4", { inpoint: 0.5, outpoint: 8 });

    // The demuxer plays whole files unless told otherwise; these directives
    // are the only way to drop the half-second a stub already covers.
    expect(line).toBe("file '/tmp/segment-1.mp4'\ninpoint 0.5\noutpoint 8");
  });

  it("emits a bare file line when nothing is trimmed", () => {
    expect(concatListLine("/tmp/segment-0.mp4")).toBe("file '/tmp/segment-0.mp4'");
  });
});

describe("buildTransitionArgs", () => {
  it("crossfades exactly two inputs and nothing else", () => {
    const args = buildTransitionArgs({
      fromPath: "/tmp/segment-0.mp4",
      toPath: "/tmp/segment-1.mp4",
      outputPath: "/tmp/stub-0.mp4",
      durationSeconds: 0.5,
      startSeconds: 7.5,
    });

    // Two decoders at a time is the whole point — this is why xfade is never
    // applied across the timeline.
    expect(args.filter((arg) => arg === "-i")).toHaveLength(2);
    expect(args.join(" ")).toContain("xfade=transition=fade:duration=0.5");
    expect(args.at(-1)).toBe("/tmp/stub-0.mp4");
  });

  it("reads the outgoing clip from where the crossfade starts", () => {
    const args = buildTransitionArgs({
      fromPath: "/tmp/segment-0.mp4",
      toPath: "/tmp/segment-1.mp4",
      outputPath: "/tmp/stub-0.mp4",
      durationSeconds: 0.5,
      startSeconds: 7.5,
    });

    // -ss before the first -i, so it seeks the input rather than the output.
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(valueOf(args, "-ss")).toBe("7.5");
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
  // `clipSeconds` is part of the base rather than added per test: it is
  // required, because every slot length now comes from where its section
  // falls in the narration and there is no sane length to invent for a caller
  // that forgot to say.
  const base = { clipPath: "/tmp/a.mp4", outputPath: "/tmp/segment-0.mp4", clipSeconds: 12 };

  it("bounds the input so an infinite loop cannot decode forever", () => {
    const args = buildSegmentArgs(base);

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

  it("bounds the decoder's thread pool, not just the encoder's", () => {
    const args = buildSegmentArgs(base);
    const inputIndex = args.indexOf("-i");

    // Position is the whole point: after -i this caps only the encoder, and
    // the h264 decoder then sizes its frame-buffer pool from the host's core
    // count — hundreds of megabytes on a 4K clip, inside a 1GB container.
    const firstThreads = args.indexOf("-threads");
    expect(firstThreads).toBeGreaterThan(-1);
    expect(firstThreads).toBeLessThan(inputIndex);
    expect(args[firstThreads + 1]).toBe("1");
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

  it("forces the narration to stereo before it reaches the mix", () => {
    const graph =
      valueOf(
        buildAssembleArgs({ ...assembleBase, audio, sfxPath: "/tmp/sfx.m4a" }),
        "-filter_complex",
      ) ?? "";

    // amix adopts its first input's layout and ElevenLabs returns mono, so
    // without this the finished video is mono and the stereo music and
    // effects are silently downmixed into it.
    expect(graph).toContain("aformat=channel_layouts=stereo");
  });
});

describe("buildShortArgs", () => {
  const shortBase = {
    sourcePath: "/tmp/render.mp4",
    startSeconds: 92.5,
    durationSeconds: 34,
    srtPath: "/tmp/short.srt",
    outputPath: "/tmp/short.mp4",
  };

  it("produces a 1080x1920 frame by covering then centre-cropping", () => {
    const filter = valueOf(buildShortArgs(shortBase), "-vf") ?? "";

    // Scale-then-crop, not crop-then-scale: a source that is not exactly
    // 1920x1080 still has to come out exactly 1080x1920 rather than whatever
    // its own aspect ratio implies.
    expect(filter).toContain(
      "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
    );
  });

  it("seeks before the input, not after it", () => {
    const args = buildShortArgs(shortBase);

    // After `-i` this would decode and discard 92.5 seconds of 1080p before
    // emitting a frame — minutes of CPU per short on a two-core box.
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(valueOf(args, "-ss")).toBe("92.5");
  });

  it("bounds the decode as well as the output", () => {
    const args = buildShortArgs(shortBase);

    // Two `-t`s, one either side of `-i`: the input one stops the decoder, the
    // output one guarantees the clip cannot outrun its own recorded window.
    const durations = args.filter((_, index) => args[index - 1] === "-t");
    expect(durations).toEqual(["34", "34"]);
  });

  it("rebases both streams so the clip starts at zero", () => {
    const args = buildShortArgs(shortBase);

    // `-ss` leaves the first frame carrying a PTS up to one frame past zero.
    // The SRT is rebased to zero, and `subtitles` matches cues against frame
    // timestamps, so without this the captions run against an offset timeline.
    expect(valueOf(args, "-vf")).toContain("setpts=PTS-STARTPTS");
    expect(valueOf(args, "-af")).toBe("asetpts=PTS-STARTPTS");
  });

  it("caps the decoder pool before the input and the encoder after it", () => {
    const args = buildShortArgs(shortBase);

    // The same lesson buildSegmentArgs records: a `-threads` after `-i` caps
    // only the encoder, leaving the h264 decoder to size its pool from the
    // host's core count — which is what SIGKILLed a render inside the
    // container.
    const firstThreads = args.indexOf("-threads");
    expect(firstThreads).toBeLessThan(args.indexOf("-i"));
    expect(args[firstThreads + 1]).toBe("1");
    expect(args.lastIndexOf("-threads")).toBeGreaterThan(args.indexOf("-i"));
  });

  it("re-encodes the source's finished mix without touching its loudness", () => {
    const args = buildShortArgs(shortBase);

    // The source audio is already narration + music + effects, loudness
    // normalised by the assemble pass. Running loudnorm over it again pumps it.
    expect(args.join(" ")).not.toContain("loudnorm");
    expect(valueOf(args, "-c:a")).toBe("aac");
  });

  it("burns captions last, at the output resolution", () => {
    const filter =
      valueOf(
        buildShortArgs({
          ...shortBase,
          captions: verticalCaptionStyle(DEFAULT_STYLE.captions),
        }),
        "-vf",
      ) ?? "";

    // After the crop, so libass draws text at 1080x1920 rather than having it
    // scaled and resampled by a filter above it.
    expect(filter.indexOf("subtitles=")).toBeGreaterThan(filter.indexOf("crop="));
    expect(filter).toContain("force_style='FontName=DejaVu Sans,FontSize=15.5");
  });

  it("front-loads the moov atom so the panel can play it before it downloads", () => {
    expect(buildShortArgs(shortBase)).toContain("+faststart");
  });
});
