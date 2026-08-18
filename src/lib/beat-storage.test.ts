import { describe, expect, it } from "vitest";

import { beatAssetPath, beatClipPath, beatImagePath, beatPrefix } from "@/lib/beat-storage";

const VIDEO_ID = "11111111-2222-3333-4444-555555555555";

describe("beatClipPath", () => {
  it("files a beat's stock clip under the same prefix as the stills", () => {
    // The whole mixed design in one assertion. `render.service.ts` recognises a
    // beat-collected video by asking what is under `beats/`; a second prefix
    // for the clips would mean a second question, and a video that answered yes
    // to both would have two competing picture plans with nothing to reconcile
    // them.
    expect(beatClipPath(VIDEO_ID, 3).startsWith(beatPrefix(VIDEO_ID))).toBe(true);
    expect(beatImagePath(VIDEO_ID, 3).startsWith(beatPrefix(VIDEO_ID))).toBe(true);
  });

  it("differs from the still of the same beat only by extension", () => {
    // Which is the one thing the renderer reads: `isStillImagePath` decides
    // `-loop 1` versus `-stream_loop -1` from exactly this suffix, and nothing
    // else anywhere is told which slots are which.
    expect(beatClipPath(VIDEO_ID, 7)).toBe(
      beatImagePath(VIDEO_ID, 7).replace(/\.png$/, ".mp4"),
    );
  });

  it("keeps play order lexicographic however the two kinds interleave", () => {
    // A query ordered by `storagePath` has to still be in the order the
    // pictures are shown. The digits are zero-padded, so they decide before the
    // extension is ever compared — `beat-003.mp4` sorts between `beat-002.png`
    // and `beat-004.png` rather than after every PNG.
    const paths = [
      beatImagePath(VIDEO_ID, 2),
      beatClipPath(VIDEO_ID, 3),
      beatImagePath(VIDEO_ID, 4),
      beatClipPath(VIDEO_ID, 10),
      beatImagePath(VIDEO_ID, 11),
    ];

    expect([...paths].sort()).toEqual(paths);
  });
});

describe("beatAssetPath", () => {
  it("resolves a beat to whichever kind collection actually stored", () => {
    const present = new Set([beatImagePath(VIDEO_ID, 0), beatClipPath(VIDEO_ID, 1)]);

    expect(beatAssetPath(present, VIDEO_ID, 0)).toBe(beatImagePath(VIDEO_ID, 0));
    expect(beatAssetPath(present, VIDEO_ID, 1)).toBe(beatClipPath(VIDEO_ID, 1));
  });

  it("returns null for a beat with neither, which the renderer refuses on", () => {
    // Not "falls back to the still's path". A path that does not exist would
    // reach FFmpeg as a missing input, and the guard that names the beat is the
    // only thing standing between that and a video whose pictures run ahead of
    // its words from the middle onward.
    expect(beatAssetPath(new Set(), VIDEO_ID, 4)).toBeNull();
  });

  it("prefers the still when a beat somehow has both", () => {
    // Reachable only by a motion shot drawn as a fallback on one run and
    // downloaded on a later one. The drawn one is already paid for and matches
    // the rest of the video's look, and picking deterministically is what stops
    // two renders of the same video differing.
    const present = new Set([beatImagePath(VIDEO_ID, 5), beatClipPath(VIDEO_ID, 5)]);

    expect(beatAssetPath(present, VIDEO_ID, 5)).toBe(beatImagePath(VIDEO_ID, 5));
  });

  it("does not confuse one video's beats with another's", () => {
    const other = "99999999-8888-7777-6666-555555555555";
    const present = new Set([beatImagePath(other, 0)]);

    expect(beatAssetPath(present, VIDEO_ID, 0)).toBeNull();
  });
});
