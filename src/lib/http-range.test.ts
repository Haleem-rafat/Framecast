import { describe, expect, it } from "vitest";

import { parseRangeHeader } from "@/lib/http-range";

describe("parseRangeHeader", () => {
  it("returns null when no Range header was sent", () => {
    expect(parseRangeHeader(null, 1000)).toBeNull();
    expect(parseRangeHeader(undefined, 1000)).toBeNull();
  });

  it("parses a closed range", () => {
    expect(parseRangeHeader("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
  });

  it("parses an open-ended range as running to the last byte", () => {
    expect(parseRangeHeader("bytes=900-", 1000)).toEqual({ start: 900, end: 999 });
  });

  it("parses a suffix range as the final N bytes", () => {
    expect(parseRangeHeader("bytes=-500", 1000)).toEqual({ start: 500, end: 999 });
  });

  it("clamps an end past the last byte, which browsers send routinely", () => {
    expect(parseRangeHeader("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
  });

  it("reports a start at or past the end of the file as unsatisfiable", () => {
    expect(parseRangeHeader("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=2000-3000", 1000)).toBe("unsatisfiable");
  });

  it("treats a suffix longer than the file as the whole file", () => {
    expect(parseRangeHeader("bytes=-5000", 1000)).toEqual({ start: 0, end: 999 });
  });

  // A multi-range request is legal HTTP and would need a multipart/byteranges
  // response. Serving the whole file instead is a permitted, and far simpler,
  // answer than implementing multipart for a video player that never asks.
  it("serves the whole file for a multi-range request", () => {
    expect(parseRangeHeader("bytes=0-99,200-299", 1000)).toBeNull();
  });

  it("ignores a malformed or non-bytes range", () => {
    expect(parseRangeHeader("items=0-99", 1000)).toBeNull();
    expect(parseRangeHeader("bytes=abc-def", 1000)).toBeNull();
    expect(parseRangeHeader("bytes=-", 1000)).toBeNull();
    expect(parseRangeHeader("", 1000)).toBeNull();
  });

  it("reports any range against an empty file as unsatisfiable", () => {
    expect(parseRangeHeader("bytes=0-", 0)).toBe("unsatisfiable");
  });
});
