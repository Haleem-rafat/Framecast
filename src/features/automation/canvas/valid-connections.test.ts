import { describe, expect, it } from "vitest";

import {
  connectionOutcome,
  type CanvasNodeRef,
} from "@/features/automation/canvas/valid-connections";

/**
 * The canvas's whole correctness, asserted without a database or a browser.
 *
 * Every row of the rules table in the design doc appears here, and so does its
 * negative: a rule that only ever gets tested in the direction that succeeds is
 * a rule nobody has checked.
 */

const channel = (id = "c1", hasReleaseCadence = false): CanvasNodeRef => ({
  kind: "CHANNEL",
  id,
  hasReleaseCadence,
});
const series = (id = "s1"): CanvasNodeRef => ({
  kind: "AUTOMATION",
  id,
  automationKind: "SERIES",
});
const queue = (id = "q1"): CanvasNodeRef => ({
  kind: "AUTOMATION",
  id,
  automationKind: "TOPIC_QUEUE",
});
const drip = (id = "r1"): CanvasNodeRef => ({
  kind: "AUTOMATION",
  id,
  automationKind: "RELEASE_CADENCE",
});
const publish = (id = "s1"): CanvasNodeRef => ({ kind: "PUBLISH", id });

describe("what the canvas accepts", () => {
  it("lets a channel adopt a series", () => {
    expect(connectionOutcome(channel(), series())).toEqual({
      valid: true,
      action: "REPARENT",
    });
  });

  it("lets a channel adopt a topic queue", () => {
    expect(connectionOutcome(channel(), queue())).toEqual({
      valid: true,
      action: "REPARENT",
    });
  });

  it("wires an automation to its own publish step", () => {
    expect(connectionOutcome(series("s1"), publish("s1"))).toEqual({
      valid: true,
      action: "ENABLE_PUBLISH",
    });
  });

  it("attaches a shorts drip to a channel that has none", () => {
    expect(connectionOutcome(channel("c1", false), drip())).toEqual({
      valid: true,
      action: "ATTACH_CADENCE",
    });
  });
});

describe("what the canvas refuses", () => {
  it("refuses a second shorts drip on one channel", () => {
    // ReleaseCadence.channelId is @unique. The refusal has to be visible while
    // dragging, not after dropping.
    expect(connectionOutcome(channel("c1", true), drip()).valid).toBe(false);
  });

  it("refuses a channel dropped on a channel", () => {
    expect(connectionOutcome(channel("c1"), channel("c2")).valid).toBe(false);
  });

  it("refuses an automation dropped on an automation", () => {
    expect(connectionOutcome(series("s1"), queue("q1")).valid).toBe(false);
  });

  it("refuses a publish step as a source", () => {
    expect(connectionOutcome(publish(), series()).valid).toBe(false);
  });

  it("refuses a channel dropped on a publish step", () => {
    expect(connectionOutcome(channel("c1"), publish("s1")).valid).toBe(false);
  });

  it("refuses wiring an automation to another automation's publish step", () => {
    // The dangerous one: allowing it would turn on auto-publish for a show the
    // operator was not pointing at.
    expect(connectionOutcome(series("s1"), publish("s2")).valid).toBe(false);
  });

  it("refuses a shorts drip a publish step", () => {
    expect(connectionOutcome(drip("r1"), publish("r1")).valid).toBe(false);
  });
});

describe("the refusals themselves", () => {
  it("gives every refusal a sentence worth reading", () => {
    const refusals = [
      connectionOutcome(channel("c1", true), drip()),
      connectionOutcome(channel("c1"), channel("c2")),
      connectionOutcome(series("s1"), queue("q1")),
      connectionOutcome(publish(), series()),
      connectionOutcome(channel("c1"), publish("s1")),
      connectionOutcome(series("s1"), publish("s2")),
      connectionOutcome(drip("r1"), publish("r1")),
    ];

    for (const outcome of refusals) {
      if (outcome.valid) throw new Error("expected a refusal");
      // A greyed-out target answers "no"; the tooltip has to answer "why not".
      expect(outcome.reason.length).toBeGreaterThan(20);
      expect(outcome.reason.trim()).toMatch(/\.$/);
    }
  });
});
