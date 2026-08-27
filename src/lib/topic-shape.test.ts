import { describe, expect, it } from "vitest";

import {
  CLAIM_VERBS,
  MIN_TOPIC_WORDS,
  TENSION_MARKERS,
  describeTopicShape,
} from "@/lib/topic-shape";

/** Topics that already carry the thing the video will open on. */
const SHAPED = [
  "France made Haiti pay for its own freedom for 122 years",
  "the treaty that redrew Europe was negotiated between parties and affairs",
  "he got a raise and took home less money",
  "more choices, 10x fewer sales",
  "why a $10 fine hurts more than a $500 bill",
  "a company that made a profit every year and still collapsed",
];

/** Topics that name a subject and leave the surprise to be invented. */
const THIN = [
  "Enron",
  "compound interest",
  "Congress of Vienna",
  "the history of money",
  "an introduction to index funds for complete beginners",
];

describe("describeTopicShape", () => {
  it.each(SHAPED)("accepts a topic that makes a claim: %s", (topic) => {
    expect(describeTopicShape(topic)).toEqual({ ok: true, hint: null });
  });

  it.each(THIN)("flags a topic that only names a subject: %s", (topic) => {
    const result = describeTopicShape(topic);

    expect(result.ok).toBe(false);
    expect(result.hint).toContain(topic);
  });

  it("flags an empty topic without quoting it back", () => {
    expect(describeTopicShape("   ")).toEqual({ ok: false, hint: "This topic is empty." });
  });

  it("says something different about a label than about a description", () => {
    const label = describeTopicShape("Enron");
    const description = describeTopicShape(
      "an introduction to index funds for complete beginners",
    );

    expect(label.hint).toContain("names a subject");
    expect(description.hint).toContain("never says what");
  });

  it.each([...CLAIM_VERBS])("treats %s as a claim", (verb) => {
    expect(describeTopicShape(`the bank ${verb} something nobody expected`).ok).toBe(
      true,
    );
  });

  it.each([...TENSION_MARKERS])("treats %s as a tension", (marker) => {
    // Kept under MIN_TOPIC_WORDS-independent: the marker alone must carry it.
    expect(describeTopicShape(`a country ${marker} a currency`).ok).toBe(true);
  });

  it("counts a number as a shape of its own", () => {
    expect(describeTopicShape("$9.99 a month for three years").ok).toBe(true);
  });

  it("counts a participle as a claim", () => {
    expect(describeTopicShape("a nation bankrupted by its own independence").ok).toBe(
      true,
    );
  });

  it("does not read a short word ending in -ed as a participle", () => {
    expect(describeTopicShape("red").ok).toBe(false);
  });

  it("ignores punctuation and case when looking for a claim", () => {
    expect(describeTopicShape("THE BANK — IT PAID NOTHING.").ok).toBe(true);
  });

  it(`treats fewer than ${MIN_TOPIC_WORDS} words with no claim as a label`, () => {
    expect(describeTopicShape("the Enron collapse").hint).toContain("names a subject");
  });

  it("never refuses, only advises", () => {
    // The contract the queue depends on: there is no throw and no rewrite here,
    // whatever the topic says.
    for (const topic of [...SHAPED, ...THIN, "", "?!"]) {
      expect(() => describeTopicShape(topic)).not.toThrow();
    }
  });
});

describe("describeTopicShape: what it deliberately cannot tell apart", () => {
  /**
   * The check asks "is there a finite verb anywhere in here", which a verb in a
   * relative clause answers just as loudly as the main one. So a thin topic
   * that happens to trail a "who sell them" reads as shaped.
   *
   * Distinguishing them needs a parser, and the whole output is one line of
   * advice beside a text field — a wrong hint costs a sentence nobody had to
   * read, and a parser would cost a dependency in a module that has none. The
   * test is here so the limit is known rather than discovered.
   */
  it("reads a verb in a subordinate clause as a claim", () => {
    expect(
      describeTopicShape("an introduction to index funds and the people who sell them")
        .ok,
    ).toBe(true);
  });
});
