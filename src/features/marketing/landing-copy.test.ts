import { describe, expect, it } from "vitest";

import {
  APPROVAL_GATES,
  CREDIBILITY,
  CTA,
  HOOK,
  VALUE_PROPOSITION,
} from "@/features/marketing/landing-copy";

/**
 * The landing page has no behaviour to test. It has a *structure*, and the
 * structure is the thing that decays — see `landing-copy.ts` for why the copy
 * lives in a constant at all.
 *
 * Each assertion below corresponds to one rule of the four-block structure in
 * the `assessment-landing-page` skill. They are not style checks: every one of
 * them is a rule whose removal costs conversions silently, which is exactly the
 * kind of change that otherwise ships because the build still passes.
 */

describe("Block 1 — the hook", () => {
  // The mechanism of a frustration hook. Without a clause naming the effort
  // the reader is already making, the sentence blames them for the gap.
  it("names the effort the reader is already making", () => {
    expect(HOOK.subheading).toMatch(/not a shortage of effort/i);
  });

  // A hook is about the reader. The moment it describes the product it has
  // become a mechanism sentence, which belongs in block 2.
  it("does not describe the product", () => {
    const hook = `${HOOK.headline} ${HOOK.headlineEmphasis} ${HOOK.subheading}`;

    expect(hook).not.toMatch(/framecast/i);
    expect(hook).not.toMatch(/\bAI\b/);
  });

  it("puts a concrete number on the cost of the problem", () => {
    expect(HOOK.subheading).toMatch(/\d|eleven|three/i);
  });
});

describe("Block 2 — the value proposition", () => {
  // Three. Not two, not five. A fourth is always the one that turns this back
  // into a feature list, which is what this block replaced.
  it("names exactly three outcomes", () => {
    expect(VALUE_PROPOSITION.outcomes).toHaveLength(3);
  });

  it("frames each one as the reader's, not the product's", () => {
    for (const outcome of VALUE_PROPOSITION.outcomes) {
      expect(outcome.name).toMatch(/^Your /);
    }
  });

  it("says it measures and improves them", () => {
    expect(VALUE_PROPOSITION.intro).toMatch(/measures and improves/i);
  });
});

describe("Block 3 — credibility", () => {
  it("makes three checkable claims", () => {
    expect(CREDIBILITY.facts).toHaveLength(3);

    for (const fact of CREDIBILITY.facts) {
      expect(fact.detail.length).toBeGreaterThan(40);
    }
  });

  // The one rule this block cannot bend. A fabricated logo wall or invented
  // testimonial is the single thing on a landing page a reader can catch out,
  // and an empty section costs less than a false one. `operatorNote` is the
  // marked place for a real bio; it stays null until somebody can say
  // something true there.
  it("invents no social proof", () => {
    const text = JSON.stringify(CREDIBILITY).toLowerCase();

    for (const claim of ["trusted by", "customers", "testimonial", "join thousands", "loved by"]) {
      expect(text).not.toContain(claim);
    }
  });
});

describe("Block 4 — the call to action", () => {
  // The combination is what converts, not any one element. A CTA that loses
  // its duration in a tidy-up still reads fine, which is precisely why this
  // is a test rather than a comment.
  it("carries all four elements", () => {
    expect(CTA.action).toBeTruthy();
    expect(CTA.duration).toBeTruthy();
    expect(CTA.price).toBeTruthy();
    expect(CTA.payoff).toBeTruthy();
  });

  it("names the literal next action rather than a vague one", () => {
    expect(CTA.action).not.toMatch(/get started|learn more|find out more|explore/i);
  });

  it("commits to a duration and a price rather than hedging them", () => {
    expect(CTA.duration).toMatch(/minute|hour/i);
    expect(CTA.price).toMatch(/free/i);
  });
});

describe("the promise page.tsx asks editors to keep", () => {
  // Not a structural rule — a specific instruction left in page.tsx by whoever
  // removed the screenshot that used to carry it. The claim is the line
  // between this product and "an AI posts to my channel unsupervised".
  it("still says the pipeline stops twice", () => {
    expect(APPROVAL_GATES.lead).toMatch(/stops twice/i);
    expect(APPROVAL_GATES.detail).toMatch(/approved the script/i);
    expect(APPROVAL_GATES.detail).toMatch(/watched the finished video/i);
  });
});
