import { describe, expect, it } from "vitest";

import {
  ANAPHORIC_DETERMINERS,
  BACK_REFERENCE_OPENERS,
  CONTINUATION_OPENERS,
  FORMULA_OPENERS,
  checkFreshOpening,
  checkHook,
  firstSentence,
  openingKey,
} from "@/lib/short-hook";

/**
 * Openings that carry their whole surprise inside the first sentence.
 *
 * The gate exists to refuse hooks, so what it must never do is refuse a good
 * one. These are asserted rather than described because a false positive here
 * costs a retry on every generation and teaches an operator to ignore the
 * gate — the most expensive way this module can fail.
 */
const SELF_CONTAINED = [
  "Did you know the peace deal that shaped modern Europe was mostly negotiated " +
    "between parties and scandals?",
  "Did you know a nation of freed slaves was forced to pay their former " +
    "enslaver for the crime of freeing themselves?",
  "A flood buried more Renaissance art in one night than any war had.",
  "The bank charged him nothing to lose his house.",
  "Nobody in the room had read the contract they were all about to sign.",
];

describe("firstSentence", () => {
  it("stops at the first full stop", () => {
    expect(firstSentence("One thing happened. Then another.")).toBe(
      "One thing happened.",
    );
  });

  it("stops at a question mark, which is how most hooks end", () => {
    expect(firstSentence("Did you know this? Here is why.")).toBe(
      "Did you know this?",
    );
  });

  it("returns the whole string when there is no terminator at all", () => {
    expect(firstSentence("a hook with no full stop")).toBe(
      "a hook with no full stop",
    );
  });

  it("does not split on the full stop inside a number", () => {
    expect(firstSentence("It cost $9.99 a month. For three years.")).toBe(
      "It cost $9.99 a month.",
    );
  });

  it("collapses whitespace so a reflowed edit still matches", () => {
    expect(firstSentence("  two   words\nhere. next")).toBe("two words here.");
  });
});

describe("checkHook", () => {
  it.each(SELF_CONTAINED)("accepts a hook that stands on its own: %s", (hook) => {
    expect(checkHook(hook)).toEqual({ ok: true, errors: [] });
  });

  it("reads only the first sentence, not the whole script", () => {
    // The second sentence opens with a continuation word, which is fine — by
    // then the viewer has the first one.
    expect(checkHook("A flood buried Florence's art. Then strangers came.").ok).toBe(
      true,
    );
  });

  it("rejects an empty hook rather than passing it silently", () => {
    expect(checkHook("   ").ok).toBe(false);
  });

  it("gives one sentence per problem, ready to paste into a retry", () => {
    const result = checkHook("Now, it happened again.");

    expect(result.errors.length).toBeGreaterThan(0);
    for (const error of result.errors) {
      expect(error.endsWith(".")).toBe(true);
    }
  });
});

describe("checkHook: continuation openers", () => {
  it("rejects a hook that resumes an argument the viewer has not heard", () => {
    const result = checkHook("Now, here's the part that sounds completely backwards.");

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("carries on from something");
  });

  it.each([...CONTINUATION_OPENERS])(
    "rejects the continuation opener %s",
    (opener) => {
      expect(checkHook(`${opener} the money was already gone.`).ok).toBe(false);
    },
  );

  it("is case-insensitive about the opener", () => {
    expect(checkHook("however the debt remained.").ok).toBe(false);
    expect(checkHook("HOWEVER the debt remained.").ok).toBe(false);
  });

  it("allows a continuation word that is not the first thing said", () => {
    expect(checkHook("The debt still had ninety years left to run.").ok).toBe(true);
  });
});

describe("checkHook: back references", () => {
  it.each([...BACK_REFERENCE_OPENERS])(
    "rejects the unbound pronoun %s",
    (pronoun) => {
      const result = checkHook(`${pronoun} cost the country a century of growth.`);

      expect(result.ok).toBe(false);
      expect(result.errors.join(" ")).toContain("has not met");
    },
  );

  it("rejects a demonstrative standing alone as the subject", () => {
    expect(checkHook("That was the moment the country lost its savings.").ok).toBe(
      false,
    );
    expect(checkHook("This is how a nation went broke.").ok).toBe(false);
  });

  it("allows a demonstrative that introduces a noun rather than standing alone", () => {
    // In front of a noun the demonstrative names what it points at, so the
    // viewer can follow it; standing alone it points at nothing.
    expect(checkHook("These three men were thrown out of a window.").ok).toBe(true);
    expect(checkHook("That summer the river swallowed a city.").ok).toBe(true);
  });

  it.each([...ANAPHORIC_DETERMINERS])(
    "rejects a hook that presupposes a comparison with 'the %s'",
    (determiner) => {
      expect(
        checkHook(`The bank charged the ${determiner} customer nothing.`).ok,
      ).toBe(false);
    },
  );

  it("does not confuse a possessive with the anaphoric determiner", () => {
    // "their former enslaver" is not "the former".
    expect(checkHook("France billed them for their former property.").ok).toBe(true);
  });
});

describe("checkHook: date-first openings", () => {
  it("rejects an opening that spends its two seconds on a date", () => {
    const result = checkHook(
      "On a Saturday in June 1995, a grocery store in Menlo Park, California " +
        "let two strangers set up a folding table by its entrance.",
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("opens on a date");
  });

  it("rejects a bare year, weekday or decade in front of the point", () => {
    expect(checkHook("In 1995 a grocery store ran an experiment.").ok).toBe(false);
    expect(checkHook("On a Tuesday the bank simply closed.").ok).toBe(false);
    expect(checkHook("Back in the eighties nobody checked.").ok).toBe(false);
    expect(checkHook("One morning the savings were gone.").ok).toBe(false);
  });

  it("allows a date that is not the first thing said", () => {
    expect(checkHook("France billed Haiti for its own freedom in 1825.").ok).toBe(
      true,
    );
  });
});

describe("checkHook: what it deliberately cannot catch", () => {
  /**
   * "The 24-flavor table won the first contest easily." is the same fault as
   * every hook above — a definite noun phrase for a thing the viewer has never
   * seen — and it is let through.
   *
   * No lexical rule catches it without also rejecting "The first man to walk on
   * the moon…", which is a perfectly good hook. A gate that fires on good hooks
   * costs a retry every time and teaches an operator to ignore it, so this one
   * is left to the prompt. The test exists so nobody adds the rule later
   * without knowing it was considered and refused.
   */
  it("passes a definite reference to something the viewer has not seen", () => {
    expect(checkHook("The 24-flavor table won the first contest easily.").ok).toBe(
      true,
    );
  });
});

describe("checkFreshOpening", () => {
  it("refuses every formula opener", () => {
    for (const opener of FORMULA_OPENERS) {
      expect(checkFreshOpening(`${opener} the sea was a road.`, []).ok).toBe(false);
    }
  });

  it("refuses an opening whose first three words match a recent one", () => {
    const result = checkFreshOpening("The wisest emperor chose his son.", [
      "The wisest emperor wrote twelve books.",
    ]);

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('"the wisest emperor"');
  });

  it("ignores case and punctuation when matching", () => {
    expect(openingKey("Rome, burned — twice.")).toBe("rome burned twice");
  });

  it("accepts a fresh opening", () => {
    expect(
      checkFreshOpening("Marcus Aurelius handed Rome to a lunatic.", [
        "China burned the largest fleet on earth.",
      ]).ok,
    ).toBe(true);
  });
});
