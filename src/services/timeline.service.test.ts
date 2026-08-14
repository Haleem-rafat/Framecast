import { describe, expect, it } from "vitest";

import type { Alignment } from "@/lib/captions";
import { extractAnchor, type ScriptCue, sectionDurations } from "@/lib/script-cues";
import { DEFAULT_STYLE } from "@/lib/video-style";
import {
  minClipSecondsFor,
  planPoolBlocks,
  planSections,
  rerunAvailability,
  sectionClipPath,
} from "@/services/timeline.service";

// Unlike script.service.test.ts, nothing in this file touches Postgres or the
// storage root. That is deliberate rather than convenient: every number this
// service shows an operator comes out of `planSections`, which is pure, and a
// test that needed a live database to check an arithmetic invariant would be a
// test nobody could run while changing the arithmetic. `TimelineService`'s own
// methods (ownership scoping, the clip lookup, the swap) are covered by the
// service-level suite conventions elsewhere; what is pinned here is the part
// where being subtly wrong produces a plausible-looking, mistimed picture.

/**
 * An alignment where character `i` is spoken during second `i * secondsPerChar`
 * — enough to make every assertion below a number that can be read off by hand,
 * which a real ElevenLabs alignment is not.
 */
function evenAlignment(text: string, secondsPerChar = 0.1): Alignment {
  const characters = [...text];

  return {
    characters,
    characterStartTimesSeconds: characters.map((_char, index) => index * secondsPerChar),
    characterEndTimesSeconds: characters.map((_char, index) => (index + 1) * secondsPerChar),
  };
}

function cueFor(sectionText: string, cue: string): ScriptCue {
  return { anchor: extractAnchor(sectionText), cue };
}

// Three sections of ten characters each. Written as the parts so the
// expectations below can name them rather than counting into a string literal.
const PART_ONE = "aaaa bbbb ";
const PART_TWO = "cccc dddd ";
const PART_THREE = "eeee ffff";
const CONTENT = `${PART_ONE}${PART_TWO}${PART_THREE}`;

describe("minClipSecondsFor", () => {
  it("doubles the transition duration so a slot outlasts its own crossfade", () => {
    expect(minClipSecondsFor({ enabled: true, durationSeconds: 0.9 })).toBe(1.8);
  });

  it("never falls below one second, whatever the style asks for", () => {
    // The floor render.service.ts calls MIN_CLIP_SECONDS. A shorter slot is
    // what hands FFmpeg `-t 0` and produces an empty segment.
    expect(minClipSecondsFor({ enabled: true, durationSeconds: 0.2 })).toBe(1);
    expect(minClipSecondsFor({ enabled: false, durationSeconds: 5 })).toBe(1);
  });

  it("matches the default channel style the render actually uses", () => {
    // Pins the copied constant against the real DEFAULT_STYLE rather than
    // against another literal, so raising the default transition duration
    // fails here instead of silently drawing a timeline the render disagrees
    // with. See MIN_CLIP_SECONDS' comment in timeline.service.ts.
    expect(minClipSecondsFor(DEFAULT_STYLE.transitions)).toBe(1);
  });
});

describe("sectionClipPath", () => {
  it("zero-pads to the path FootageService writes and RenderService reads", () => {
    // Both of those spell this out privately; if either changes, a swap would
    // write bytes nothing ever reads, and the timeline would show no clip for
    // a section that has one.
    expect(sectionClipPath("vid", 0)).toBe("videos/vid/clips/section-000.mp4");
    expect(sectionClipPath("vid", 7)).toBe("videos/vid/clips/section-007.mp4");
    expect(sectionClipPath("vid", 128)).toBe("videos/vid/clips/section-128.mp4");
  });
});

describe("planSections", () => {
  const cues = [
    cueFor(PART_ONE, "a city at dawn"),
    cueFor(PART_TWO, "a printing press"),
    cueFor(PART_THREE, "a satellite"),
  ];

  it("places each section where its own words are spoken", () => {
    const plan = planSections({
      cues,
      content: CONTENT,
      alignment: evenAlignment(CONTENT),
      durationSeconds: 3,
      minClipSeconds: 0.5,
    });

    // Ten characters at 0.1s each: sections start at 0s, 1s and 2s.
    expect(plan.sections.map((section) => section.startSeconds)).toEqual([0, 1, 2]);
    expect(plan.sections.map((section) => section.durationSeconds)).toEqual([1, 1, 1]);
    expect(plan.sections.map((section) => section.cue)).toEqual([
      "a city at dawn",
      "a printing press",
      "a satellite",
    ]);
    expect(plan.sections.map((section) => section.narration)).toEqual([
      "aaaa bbbb",
      "cccc dddd",
      "eeee ffff",
    ]);
  });

  it("covers the whole narration with no gap and no overrun", () => {
    // The property the render depends on: the assemble pass cuts the output at
    // `durationSeconds`, so slots that summed to anything else would not make a
    // longer or shorter video — they would make one whose picture drifts off
    // its own words. Checked on a duration that divides unevenly.
    const plan = planSections({
      cues,
      content: CONTENT,
      alignment: evenAlignment(CONTENT),
      durationSeconds: 7,
      minClipSeconds: 0.5,
    });

    const last = plan.sections[plan.sections.length - 1];
    expect(plan.sections[0].startSeconds).toBe(0);
    expect(last.startSeconds + last.durationSeconds).toBeCloseTo(7, 10);

    plan.sections.forEach((section, index) => {
      if (index === 0) return;
      const previous = plan.sections[index - 1];
      expect(section.startSeconds).toBeCloseTo(
        previous.startSeconds + previous.durationSeconds,
        10,
      );
    });
  });

  it("derives the same slot lengths the renderer does", () => {
    // Not a re-implementation check — an equality check against the exact
    // library call render.service.ts makes. If this service ever grew its own
    // arithmetic, this is the test that would notice.
    const alignment = evenAlignment(CONTENT);
    const plan = planSections({
      cues,
      content: CONTENT,
      alignment,
      durationSeconds: 3,
      minClipSeconds: 0.5,
    });

    const expected = sectionDurations([0, 1, 2], 3, 0.5);
    expect(plan.sections.map((section) => section.durationSeconds)).toEqual(expected);
  });

  it("anchors against the trimmed content, as ElevenLabs was sent it", () => {
    // voiceover.service.ts sends `content.trim()`, so alignment indices are
    // indices into the trimmed string. Anchoring against the untrimmed one
    // shifts every section by the leading whitespace — the same bug
    // script.service.ts and footage.service.ts each guard against.
    const padded = `\n\n   ${CONTENT}`;
    const plan = planSections({
      cues,
      content: padded,
      alignment: evenAlignment(CONTENT),
      durationSeconds: 3,
      minClipSeconds: 0.5,
    });

    expect(plan.sections.map((section) => section.startSeconds)).toEqual([0, 1, 2]);
    expect(plan.sections[0].narration).toBe("aaaa bbbb");
  });

  it("gives a section the floor by taking it from its neighbour, not from the total", () => {
    // Two cues resolving very close together. `sectionDurations` moves the
    // boundary rather than clamping a length, so section two is pushed late and
    // section three pays for it — the total is untouched.
    const content = "aaaa bbbb cccc";
    const plan = planSections({
      cues: [
        cueFor("aaaa", "one"),
        cueFor("bbbb", "two"),
        cueFor("cccc", "three"),
      ],
      content,
      alignment: evenAlignment(content, 0.1),
      durationSeconds: 10,
      minClipSeconds: 2,
    });

    expect(plan.sections.map((section) => section.durationSeconds)).toEqual([2, 2, 6]);
    const last = plan.sections[2];
    expect(last.startSeconds + last.durationSeconds).toBeCloseTo(10, 10);
  });

  it("attributes an orphaned cue to the section that absorbed its narration", () => {
    // The middle cue's anchor no longer occurs, so `anchorCues` drops it and
    // section one runs on through its text. That section's single clip now
    // plays under words it was never chosen for, which is exactly what the
    // view has to be able to point at.
    const plan = planSections({
      cues: [
        cueFor(PART_ONE, "a city at dawn"),
        { anchor: "words the operator rewrote away entirely", cue: "a printing press" },
        cueFor(PART_THREE, "a satellite"),
      ],
      content: CONTENT,
      alignment: evenAlignment(CONTENT),
      durationSeconds: 3,
      minClipSeconds: 0.5,
    });

    expect(plan.orphanedCueCount).toBe(1);
    expect(plan.sections).toHaveLength(2);
    expect(plan.sections[0].absorbedOrphanCues).toEqual(["a printing press"]);
    expect(plan.sections[1].absorbedOrphanCues).toEqual([]);
    // Section one now spans its own words and the orphan's.
    expect(plan.sections[0].narration).toBe("aaaa bbbb cccc dddd");
    expect(plan.sections[0].durationSeconds).toBeCloseTo(2, 10);
  });

  it("reports an orphan before the first surviving cue separately", () => {
    // Nothing absorbed it: `sectionDurations` stretches the first slot back to
    // zero, so those words play under section one without lengthening it.
    const plan = planSections({
      cues: [
        { anchor: "nothing in this script says this", cue: "a lost cue" },
        cueFor(PART_TWO, "a printing press"),
        cueFor(PART_THREE, "a satellite"),
      ],
      content: CONTENT,
      alignment: evenAlignment(CONTENT),
      durationSeconds: 3,
      minClipSeconds: 0.5,
    });

    expect(plan.leadingOrphanCues).toEqual(["a lost cue"]);
    expect(plan.orphanedCueCount).toBe(1);
    expect(plan.sections.every((section) => section.absorbedOrphanCues.length === 0)).toBe(
      true,
    );
    expect(plan.sections[0].startSeconds).toBe(0);
  });

  it("reports no sections when every cue has been orphaned", () => {
    // The state render.service.ts reads as "uncued": it falls back to the
    // topic pool, so the view must not draw section boundaries at all.
    const plan = planSections({
      cues: [{ anchor: "no longer present anywhere", cue: "a lost cue" }],
      content: CONTENT,
      alignment: evenAlignment(CONTENT),
      durationSeconds: 3,
      minClipSeconds: 0.5,
    });

    expect(plan.sections).toEqual([]);
    expect(plan.orphanedCueCount).toBe(1);
    expect(plan.leadingOrphanCues).toEqual(["a lost cue"]);
  });

  it("shares the narration equally when there are more sections than seconds", () => {
    // `sectionDurations`' degenerate branch. render.service.ts refuses to
    // render this, but the timeline still has to describe it rather than
    // dividing by zero on the way to an empty strip.
    const content = "aa bb cc dd";
    const plan = planSections({
      cues: [cueFor("aa", "one"), cueFor("bb", "two"), cueFor("cc", "three"), cueFor("dd", "four")],
      content,
      alignment: evenAlignment(content, 0.1),
      durationSeconds: 2,
      minClipSeconds: 1,
    });

    expect(plan.sections.map((section) => section.durationSeconds)).toEqual([
      0.5, 0.5, 0.5, 0.5,
    ]);
  });
});

describe("planPoolBlocks", () => {
  it("divides the narration equally between the pooled clips", () => {
    const blocks = planPoolBlocks({ clipCount: 4, durationSeconds: 60, minClipSeconds: 1 });

    expect(blocks.map((block) => block.startSeconds)).toEqual([0, 15, 30, 45]);
    expect(blocks.every((block) => block.durationSeconds === 15)).toBe(true);
    expect(blocks.every((block) => block.visibleSeconds === 15)).toBe(true);
  });

  it("marks the blocks the assemble pass cuts off the end", () => {
    // Four clips over a three-second narration: the floor wins, the slots
    // overshoot, and `-t durationSeconds` trims the tail. Blocks past the end
    // are never seen — drawing them full width would show an operator video
    // that does not exist.
    const blocks = planPoolBlocks({ clipCount: 4, durationSeconds: 3, minClipSeconds: 1 });

    expect(blocks.map((block) => block.durationSeconds)).toEqual([1, 1, 1, 1]);
    expect(blocks.map((block) => block.visibleSeconds)).toEqual([1, 1, 1, 0]);
  });
});

describe("rerunAvailability", () => {
  const now = new Date("2026-08-14T12:00:00Z");
  const past = new Date("2026-08-14T11:00:00Z");
  const future = new Date("2026-08-14T13:00:00Z");

  it("offers Run for a queued video", () => {
    const result = rerunAvailability(
      { status: "QUEUED", attempts: 0, leaseExpiresAt: null },
      now,
    );

    expect(result).toMatchObject({ available: true, control: "run" });
  });

  it("offers Retry for a failed video with attempts left", () => {
    const result = rerunAvailability(
      { status: "FAILED", attempts: 1, leaseExpiresAt: null },
      now,
    );

    expect(result).toMatchObject({ available: true, control: "retry" });
  });

  it("refuses a failed video that has used every attempt", () => {
    // Mirrors JobService.requeue's own `attempts < MAX_ATTEMPTS` gate: the
    // queue will not run this again, so an edit stored for it could not take
    // effect.
    const result = rerunAvailability(
      { status: "FAILED", attempts: 3, leaseExpiresAt: null },
      now,
    );

    expect(result.available).toBe(false);
    expect(result.control).toBeNull();
  });

  it("refuses a video a worker is holding right now", () => {
    // A live lease means clips may be being downloaded this second; writing
    // underneath that lands in an unpredictable half of the render.
    const result = rerunAvailability(
      { status: "RENDERING", attempts: 1, leaseExpiresAt: future },
      now,
    );

    expect(result.available).toBe(false);
  });

  it("offers Run for a video stranded by a dead worker", () => {
    const result = rerunAvailability(
      { status: "GENERATING", attempts: 1, leaseExpiresAt: past },
      now,
    );

    expect(result).toMatchObject({ available: true, control: "run" });
  });

  it("refuses a finished video, because the pipeline skips its render stage", () => {
    // The one an operator is most likely to be looking at, and the reason the
    // view says so out loud instead of offering a swap that could never take
    // effect: `runPipeline` returns "video is already READY — skipped", and
    // `JobService.requeue` refuses a READY video outright.
    const result = rerunAvailability(
      { status: "READY", attempts: 1, leaseExpiresAt: null },
      now,
    );

    expect(result.available).toBe(false);
    expect(result.reason).toContain("already rendered");
  });

  it("refuses a published video", () => {
    const result = rerunAvailability(
      { status: "PUBLISHED", attempts: 1, leaseExpiresAt: null },
      now,
    );

    expect(result.available).toBe(false);
  });
});
