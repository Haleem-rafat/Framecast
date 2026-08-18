import { describe, expect, it } from "vitest";

import {
  buildAssembleArgs,
  buildSegmentArgs,
  buildTransitionArgs,
  concatListLine,
  FRAME_SIZES,
  frameSize,
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

  it("marks image paths as stills and video paths as not", () => {
    const plan = planRender(
      ["/tmp/beat-000.png", "/tmp/b.mp4", "/tmp/beat-001.JPEG"],
      "/tmp",
      evenDurations(3, 20),
    );

    expect(plan.segments.map((segment) => segment.still)).toEqual([true, false, true]);
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

describe("planRender with a transition per boundary", () => {
  const dissolve = { enabled: true, durationSeconds: 0.5 };
  const cut = { enabled: false, durationSeconds: 0 };
  const dip = { enabled: true, durationSeconds: 0.2, kind: "fadeblack" as const };

  const clips = ["/tmp/a.mp4", "/tmp/b.mp4", "/tmp/c.mp4", "/tmp/d.mp4"];
  const lengths = [6, 6, 6, 6];

  it("builds a stub only where a join actually dissolves", () => {
    const plan = planRender(clips, "/tmp", lengths, [cut, dip, cut]);

    expect(plan.transitions).toHaveLength(1);
    expect(plan.transitions[0].kind).toBe("fadeblack");
    expect(plan.transitions[0].durationSeconds).toBe(0.2);
  });

  it("tells each job which join it covers", () => {
    // The whole reason boundaryIndex exists: with hard cuts in the timeline a
    // job's position in the array is no longer the boundary it covers, and the
    // composer keys built stubs by this.
    const plan = planRender(clips, "/tmp", lengths, [cut, dip, cut]);

    expect(plan.transitions[0].boundaryIndex).toBe(1);
  });

  it("answers for every boundary, including the hard cuts", () => {
    const plan = planRender(clips, "/tmp", lengths, [cut, dip, cut]);

    // Three joins between four clips. Zero is a real answer and means a cut —
    // the composer walks this to place cues, and a missing entry would drift
    // everything after it.
    expect(plan.boundaryOverlaps).toEqual([0, 0.2, 0]);
  });

  it("only lengthens the segment that actually donates a tail", () => {
    const plan = planRender(clips, "/tmp", lengths, [cut, dip, cut]);

    // Clip 2 donates 0.2s to the dip; the rest are exactly their slot.
    expect(plan.segments.map((segment) => segment.clipSeconds)).toEqual([6, 6.2, 6, 6]);
  });

  it("trims only at the boundaries that have a stub", () => {
    const plan = planRender(clips, "/tmp", lengths, [cut, dip, cut]);

    expect(plan.trims[0]).toEqual({ inpoint: undefined, outpoint: undefined });
    expect(plan.trims[1]).toEqual({ inpoint: undefined, outpoint: 6 });
    expect(plan.trims[2]).toEqual({ inpoint: 0.2, outpoint: undefined });
    expect(plan.trims[3]).toEqual({ inpoint: undefined, outpoint: undefined });
  });

  it("keeps the timeline the same length as the narration", () => {
    const plan = planRender(clips, "/tmp", lengths, [cut, dip, cut]);

    const played =
      plan.trimmedSeconds.reduce((sum, seconds) => sum + seconds, 0) +
      plan.boundaryOverlaps.reduce((sum, seconds) => sum + seconds, 0);

    expect(played).toBeCloseTo(24, 5);
  });

  it("matches the single-style plan when every boundary is the same", () => {
    // The compatibility guarantee. An array of identical styles must produce
    // exactly what the old single-style argument produced, or every existing
    // render changes the day a caller switches form.
    const perBoundary = planRender(clips, "/tmp", lengths, [
      dissolve,
      dissolve,
      dissolve,
    ]);
    const single = planRender(clips, "/tmp", lengths, dissolve);

    expect(perBoundary.segments).toEqual(single.segments);
    expect(perBoundary.playOrder).toEqual(single.playOrder);
    expect(perBoundary.trims).toEqual(single.trims);
    expect(perBoundary.trimmedSeconds).toEqual(single.trimmedSeconds);
    expect(perBoundary.transitions).toEqual(single.transitions);
  });

  it("refuses a list that does not have one entry per join", () => {
    // The message names both numbers, because "wrong length" without them is
    // a puzzle for whoever built the array.
    expect(() => planRender(clips, "/tmp", lengths, [dissolve, dissolve])).toThrow(
      /4 clip\(s\) have 3 joins between them, but 2 transition\(s\)/,
    );
  });

  it("still refuses a clip shorter than the join beside it", () => {
    expect(() =>
      planRender(clips, "/tmp", [6, 0.1, 6, 6], [cut, dissolve, cut]),
    ).toThrow(/shorter than/);
  });

  it("builds no stub at all when every join is a cut", () => {
    const plan = planRender(clips, "/tmp", lengths, [cut, cut, cut]);

    expect(plan.transitions).toEqual([]);
    expect(plan.trimmedSeconds).toEqual(lengths);
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
      boundaryIndex: 0,
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
      boundaryIndex: 0,
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

  it("fills a still's slot with -loop 1, which is the only thing that works", () => {
    // A PNG has no stream to rewind, so `-stream_loop -1` reads its one frame,
    // hits EOF and produces a one-frame segment whatever `-t` says. `-loop 1`
    // is the image2 demuxer's equivalent, and both it and the framerate have to
    // precede `-i` to apply to the input at all.
    const args = buildSegmentArgs({ ...base, clipPath: "/tmp/beat-000.png", still: true });

    expect(args).not.toContain("-stream_loop");
    expect(args.indexOf("-loop")).toBeLessThan(args.indexOf("-i"));
    expect(valueOf(args, "-loop")).toBe("1");
    expect(args.indexOf("-framerate")).toBeLessThan(args.indexOf("-i"));
    expect(valueOf(args, "-framerate")).toBe("30");
    expect(valueOf(args, "-t")).toBe("12");
  });

  it("leaves a stock clip's argv byte-for-byte what it always was", () => {
    // The whole safety property of the illustrated path: LIVE_ACTION renders
    // must not change. `still` absent and `still: false` have to produce the
    // identical array, or `planRender` setting it explicitly would be a
    // behaviour change for every existing video.
    expect(buildSegmentArgs({ ...base, still: false })).toEqual(buildSegmentArgs(base));
    expect(buildSegmentArgs(base)).not.toContain("-loop");
    expect(buildSegmentArgs(base)).not.toContain("-framerate");
  });

  it("still pans a still — the motion comes from the renderer, not the model", () => {
    // The reason this approach works at all: the measured channels in this
    // genre are stills with slow camera motion, and the pan already exists.
    const filter =
      valueOf(
        buildSegmentArgs({
          ...base,
          clipPath: "/tmp/beat-000.png",
          still: true,
          clipSeconds: 20,
          motion: { enabled: true, scale: 1.15 },
        }),
        "-vf",
      ) ?? "";

    expect(filter).toContain("crop=w=1920:h=1080");
    expect(filter).toContain("t/20");
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

describe("buildSegmentArgs with a Ken Burns move", () => {
  const base = {
    clipPath: "/tmp/beat-000.png",
    outputPath: "/tmp/segment-0.mp4",
    clipSeconds: 20,
    index: 0,
    still: true,
  };
  const kenburns = { enabled: true, scale: 1.15, kind: "kenburns" } as const;

  it("emits the pan it always did when no kind is asked for", () => {
    // The test that matters most in this file. `MotionStyle.kind` is optional
    // so that every channel styled before it existed keeps rendering the same
    // pictures — not "an equivalent filter", the same string. Written out in
    // full rather than as a set of `toContain`s, because a regression here
    // would be a byte that moved, and `toContain` is exactly what would miss
    // it.
    const filter = valueOf(
      buildSegmentArgs({ ...base, motion: { enabled: true, scale: 1.15 } }),
      "-vf",
    );

    expect(filter).toBe(
      "scale=2208:1242:force_original_aspect_ratio=increase,crop=2208:1242,fps=30," +
        "crop=w=1920:h=1080:x='(in_w-out_w)*t/20':y='(in_h-out_h)/2',setsar=1",
    );
  });

  it("pushes in and drifts at once off a 4x pre-upscale", () => {
    const filter = valueOf(buildSegmentArgs({ ...base, motion: kenburns }), "-vf");

    // 1536x1024 is what the image model returns for a landscape beat, and 4x of
    // it is where `zoompan`'s integer crop origin stops quantising the move
    // into held frames. Both halves of the move are asserted because either
    // alone is a different, worse effect: no pre-upscale is a judder, and no
    // drift is a plain zoom.
    expect(filter).toBe(
      "scale=6144:4096:force_original_aspect_ratio=increase," +
        "zoompan=z='min(1+0.150*on/600,1.15)':d=1:" +
        "x='(iw-iw/zoom)*on/600':y='(ih-ih/zoom)/2':s=1920x1080:fps=30,setsar=1",
    );
  });

  it("never pre-upscales a video clip, whatever the channel asked for", () => {
    // The OOM guard, and the reason it is a hard condition rather than a
    // preference. A 2560x1440 stock clip upscaled 4x is ~88MB a frame beside a
    // live h264 decoder in a 640MB container — the exact shape that SIGKILLed a
    // render before. A channel set to kenburns still gets the pan on its stock
    // footage, silently and on purpose.
    const filter =
      valueOf(
        buildSegmentArgs({ ...base, clipPath: "/tmp/a.mp4", still: false, motion: kenburns }),
        "-vf",
      ) ?? "";

    expect(filter).not.toContain("zoompan");
    expect(filter).toBe(
      valueOf(
        buildSegmentArgs({
          ...base,
          clipPath: "/tmp/a.mp4",
          still: false,
          motion: { enabled: true, scale: 1.15 },
        }),
        "-vf",
      ),
    );
  });

  it("upscales a vertical still in its own shape, not a landscape one", () => {
    const filter = valueOf(
      buildSegmentArgs({ ...base, format: "VERTICAL", motion: kenburns }),
      "-vf",
    );

    // A vertical beat comes back 1024x1536. Asking for the landscape target
    // instead would make `increase` resolve it to 6144x9216 — 85MB a frame,
    // which is the footprint the still-only gate exists to avoid.
    expect(filter).toContain("scale=4096:6144:");
    expect(filter).toContain("s=1080x1920");
  });

  it("stops the push-in at the margin the style allowed", () => {
    const filter =
      valueOf(buildSegmentArgs({ ...base, motion: { ...kenburns, scale: 1.3 } }), "-vf") ?? "";

    // `z` is clamped to `motion.scale` rather than left to run: the crop window
    // is `iw/zoom`, so a zoom past the margin would be cropping into pixels the
    // pre-upscale invented.
    expect(filter).toContain("z='min(1+0.300*on/600,1.3)'");
  });

  it("honours a pre-scale the style overrides", () => {
    // 3x is the documented fallback — 4.4% frozen pairs instead of none — and
    // it exists so a memory surprise on the worker is a style change rather
    // than a code change.
    const filter =
      valueOf(buildSegmentArgs({ ...base, motion: { ...kenburns, preScale: 3 } }), "-vf") ?? "";

    expect(filter).toContain("scale=4608:3072:");
  });

  it("cycles the same four directions the pan does", () => {
    const filters = [0, 1, 2, 3, 4].map(
      (index) => valueOf(buildSegmentArgs({ ...base, index, motion: kenburns }), "-vf") ?? "",
    );

    expect(filters[0]).not.toBe(filters[1]);
    expect(filters[1]).not.toBe(filters[2]);
    expect(filters[2]).not.toBe(filters[3]);
    // Same cycle as `PAN_EXPRESSIONS`, and it has to be: a channel that
    // switches to kenburns must not have neighbouring beats move alike either.
    expect(filters[4]).toBe(filters[0]);
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

  it("emits no horizontal margin, exactly as it always has", () => {
    const joined = buildAssembleArgs({ ...assembleBase, captions }).join(" ");

    // The safe area added for vertical shorts is deliberately opt-in: a 1920px
    // frame with no overlay UI on it does not need one, and the landscape
    // render must keep producing the force_style string it always produced.
    expect(joined).not.toContain("MarginL");
    expect(joined).not.toContain("MarginR");
    expect(joined).toContain(
      "force_style='FontName=DejaVu Sans,FontSize=22,PrimaryColour=&H00FFFFFF," +
        "OutlineColour=&H00000000,Outline=2,Shadow=1,MarginV=60'",
    );
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

describe("frame formats", () => {
  const segmentBase = {
    clipPath: "/tmp/clip.mp4",
    outputPath: "/tmp/segment-0.mp4",
    clipSeconds: 12,
  };

  it("treats an absent format as landscape, argument for argument", () => {
    // The whole compatibility claim of this change in one assertion: every
    // caller written before formats existed passes no format, and must
    // therefore produce byte-for-byte the argv it always did.
    expect(buildSegmentArgs(segmentBase)).toEqual(
      buildSegmentArgs({ ...segmentBase, format: "LANDSCAPE" }),
    );
    expect(frameSize()).toEqual(FRAME_SIZES.LANDSCAPE);
  });

  it("normalises a clip into a 1080x1920 frame when the video is vertical", () => {
    const filter =
      valueOf(buildSegmentArgs({ ...segmentBase, format: "VERTICAL" }), "-vf") ?? "";

    // Cover then centre-crop, the same idiom the landscape case uses, run the
    // other way round: a 16:9 source is scaled until it is 1920 tall and the
    // middle 1080 columns are kept. This is a crop of the SOURCE — the thing
    // that makes a vertical render native rather than a crop of a finished
    // landscape frame.
    expect(filter).toContain("scale=1080:1920:force_original_aspect_ratio=increase");
    expect(filter).toContain("crop=1080:1920");
    expect(filter).not.toContain("1920:1080");
  });

  it("pans inside the vertical frame, not the landscape one", () => {
    const filter =
      valueOf(
        buildSegmentArgs({
          ...segmentBase,
          format: "VERTICAL",
          motion: { enabled: true, scale: 1.15 },
        }),
        "-vf",
      ) ?? "";

    // 1080 x 1.15 and 1920 x 1.15. Getting this the wrong way round would
    // upscale to a landscape-shaped intermediate and crop a 9:16 window out of
    // it, which is a different picture entirely.
    expect(filter).toContain("scale=1242:2208:force_original_aspect_ratio=increase");
    expect(filter).toContain("crop=w=1080:h=1920");
  });

  it("leaves the assemble pass alone — the frame is decided by the segments", () => {
    // There is nothing format-specific in pass two: the concat demuxer joins
    // whatever the segments already are. This is why a vertical render adds no
    // pass, no filter and no memory.
    const args = buildAssembleArgs(assembleBase);
    expect(args.join(" ")).not.toContain("scale=");
    expect(args.join(" ")).not.toContain("crop=");
  });
});

describe("buildAssembleArgs over a window of the narration", () => {
  it("emits nothing at all when the whole narration is used", () => {
    // The landscape render passes no `audioStartSeconds`, so its argv is
    // unchanged — including the fact that the only `-ss` in a full render's
    // command line is no `-ss` at all.
    expect(buildAssembleArgs(assembleBase)).not.toContain("-ss");
  });

  it("seeks the narration before opening it, not after", () => {
    const args = buildAssembleArgs({ ...assembleBase, audioStartSeconds: 92.5 });
    const seekIndex = args.indexOf("-ss");
    const narrationIndex = args.indexOf("/tmp/narration.mp3");
    const concatIndex = args.indexOf("/tmp/segments.txt");

    expect(args[seekIndex + 1]).toBe("92.5");
    // Between the two inputs: after the concat list, so it cannot apply to the
    // picture, and before `-i narration.mp3`, so FFmpeg seeks the file instead
    // of decoding and discarding a minute and a half of it.
    expect(seekIndex).toBeGreaterThan(concatIndex);
    expect(seekIndex).toBeLessThan(narrationIndex);
  });

  it("cuts a window to its exact length rather than a whole second", () => {
    // A window is a run of sentences and lands on a fraction. Rounding it
    // would make the file disagree with the start/end the panel prints beside
    // it by up to half a second.
    const args = buildAssembleArgs({ ...assembleBase, durationSeconds: 34.4 });
    expect(valueOf(args, "-t")).toBe("34.4");
  });
});

describe("buildAssembleArgs with a vertical caption style", () => {
  it("carries the measured 9:16 safe area through to libass", () => {
    // The geometry itself is pinned in shorts-plan.test.ts; what this pins is
    // that it survives the trip through the assemble pass, which is now the
    // command that burns a short's captions in. It used to be `buildShortArgs`,
    // and a short whose margins silently reverted to FFmpeg's default 10 units
    // would put burned-in text under YouTube's action rail with nothing to
    // catch it.
    const filter =
      valueOf(
        buildAssembleArgs({
          ...assembleBase,
          captions: verticalCaptionStyle(DEFAULT_STYLE.captions),
        }),
        "-filter_complex",
      ) ?? "";

    expect(filter).toContain("MarginL=60");
    expect(filter).toContain("MarginR=60");
    expect(filter).toContain("MarginV=68");
  });

  it("emits no horizontal margin for a landscape style, exactly as before", () => {
    const filter =
      valueOf(
        buildAssembleArgs({ ...assembleBase, captions: DEFAULT_STYLE.captions }),
        "-filter_complex",
      ) ?? "";

    expect(filter).not.toContain("MarginL");
    expect(filter).not.toContain("MarginR");
  });
});

describe("film grain", () => {
  const base = {
    concatListPath: "/tmp/segments.txt",
    audioPath: "/tmp/narration.mp3",
    srtPath: "/tmp/captions.srt",
    outputPath: "/tmp/out.mp4",
    durationSeconds: 45,
  };

  it("lays grain under the captions, never over them", () => {
    // Captions are an edit layer over a finished picture. Grain applied after
    // the subtitles would sand the letter edges the outline exists to keep
    // crisp.
    const args = buildAssembleArgs({ ...base, grain: true });
    const graph = args[args.indexOf("-filter_complex") + 1];

    expect(graph.indexOf("noise=")).toBeLessThan(graph.indexOf("subtitles="));
  });

  it("moves the grain between frames", () => {
    // Without the temporal flag the same pattern sits frozen on every frame,
    // which reads as a dirty lens rather than as film.
    const args = buildAssembleArgs({ ...base, grain: true });

    expect(args.join(" ")).toContain("noise=alls=6:allf=t+u");
  });

  it("emits the argv it always did when grain is not asked for", () => {
    const withoutFlag = buildAssembleArgs(base);
    const explicitlyOff = buildAssembleArgs({ ...base, grain: false });

    expect(withoutFlag).toEqual(explicitlyOff);
    expect(withoutFlag.join(" ")).not.toContain("noise=");
  });
});
