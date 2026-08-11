import { describe, expect, it } from "vitest";

import { putObject, storagePath } from "@/lib/storage";

describe("storagePath", () => {
  it("namespaces by video and kind", () => {
    expect(storagePath("abc-123", "audio", "narration.mp3")).toBe(
      "videos/abc-123/audio/narration.mp3",
    );
  });

  it("rejects a filename that would escape the prefix", () => {
    expect(() => storagePath("abc-123", "audio", "../../etc/passwd")).toThrow();
  });

  it("rejects an empty filename", () => {
    expect(() => storagePath("abc-123", "audio", "")).toThrow();
  });
});

describe("putObject", () => {
  // The size check runs before the client is touched, so this never reaches
  // the network — which is the point. Supabase's own rejection names neither
  // the size sent nor the ceiling broken.
  it("refuses an oversized body and names both sizes", async () => {
    const oversized = Buffer.alloc(51 * 1024 * 1024);

    await expect(
      putObject("videos/x/output/video.mp4", oversized, "video/mp4"),
    ).rejects.toThrow(/51\.0MB exceeds the 50\.0MB per-object limit/);
  });
});

