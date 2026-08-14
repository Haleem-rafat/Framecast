import { describe, expect, it } from "vitest";

import { safeRedirectTo } from "@/lib/safe-redirect";

describe("safeRedirectTo", () => {
  it("keeps an ordinary in-app path", () => {
    expect(safeRedirectTo("/videos/abc")).toBe("/videos/abc");
  });

  it("keeps the query string and fragment", () => {
    expect(safeRedirectTo("/videos?status=DRAFT#top")).toBe(
      "/videos?status=DRAFT#top",
    );
  });

  it("falls back when nothing was asked for", () => {
    expect(safeRedirectTo(undefined)).toBe("/dashboard");
    expect(safeRedirectTo("")).toBe("/dashboard");
  });

  it("honours a caller-supplied fallback", () => {
    expect(safeRedirectTo(undefined, "/pending")).toBe("/pending");
  });

  it("rejects an absolute URL", () => {
    expect(safeRedirectTo("https://evil.example/x")).toBe("/dashboard");
    expect(safeRedirectTo("javascript:alert(1)")).toBe("/dashboard");
  });

  /**
   * The cases the old `startsWith("/") && !startsWith("//")` guard let
   * through. Each of these resolves to https://evil.example in a browser,
   * because the authority component treats a backslash as a slash.
   */
  it.each(["//evil.example", "/\\evil.example", "/\\\\evil.example"])(
    "rejects the protocol-relative form %j",
    (candidate) => {
      expect(safeRedirectTo(candidate)).toBe("/dashboard");
    },
  );

  /**
   * These two are genuinely same-origin paths — nothing decodes the escape
   * before the authority is decided — so they are refused by the explicit
   * guard rather than by the origin check, on the reasoning in the source.
   */
  it.each(["/%5cevil.example", "/%2f%2fevil.example", "/%2F/evil.example"])(
    "rejects the encoded separator %j",
    (candidate) => {
      expect(safeRedirectTo(candidate)).toBe("/dashboard");
    },
  );

  it("rejects a scheme-relative URL disguised with whitespace", () => {
    // Browsers strip tab/newline before parsing, so this is `//evil.example`.
    expect(safeRedirectTo("/\t/evil.example")).toBe("/dashboard");
  });
});
