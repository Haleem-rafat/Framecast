import { describe, expect, it } from "vitest";

import { updateBrandingSchema } from "@/schemas/channel.schema";

/**
 * The first test file for this schema, added with `beatSeconds` because that
 * field's bounds ARE the format — under five seconds is a strobe and over
 * twenty is a style the operator could have picked directly. A bound with no
 * test is a bound somebody removes while tidying.
 *
 * `.partial()` throughout: the schema has a dozen required fields that have
 * nothing to do with this one, and building a valid whole brand for each case
 * would test the other eleven fields' defaults rather than this field's rules.
 */
const parse = (beatSeconds: unknown) =>
  updateBrandingSchema.partial().parse({ beatSeconds });

describe("updateBrandingSchema — beatSeconds", () => {
  it("accepts the ends of the allowed band", () => {
    expect(parse(5).beatSeconds).toBe(5);
    expect(parse(20).beatSeconds).toBe(20);
  });

  // Under five is a strobe; over twenty is ILLUSTRATED with extra steps and
  // without its MAX_BEATS ceiling.
  it("refuses outside it", () => {
    expect(() => parse(4)).toThrow();
    expect(() => parse(21)).toThrow();
  });

  // A fractional cadence implies a precision the format does not have: the
  // writer is asked for a section count and the real seconds fall out of how
  // long the narration turns out to be.
  it("refuses a fractional cadence", () => {
    expect(() => parse(7.5)).toThrow();
  });

  // Same round-trip artStyle has: the picker's empty option and an untouched
  // field must mean one thing, and "nobody has chosen" is a real state.
  it("coerces an empty string to null", () => {
    expect(parse("").beatSeconds).toBeNull();
  });

  it("keeps null as null", () => {
    expect(parse(null).beatSeconds).toBeNull();
  });
});
