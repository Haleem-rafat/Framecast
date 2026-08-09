import { describe, expect, it } from "vitest";

import { storagePath } from "@/lib/storage";

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
