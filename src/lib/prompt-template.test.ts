import { describe, expect, it } from "vitest";

import {
  extractVariables,
  renderTemplate,
  type VariableDefinition,
} from "@/lib/prompt-template";

const topic: VariableDefinition = {
  key: "topic",
  required: true,
  defaultValue: null,
};
const tone: VariableDefinition = {
  key: "tone",
  required: false,
  defaultValue: "neutral",
};

describe("extractVariables", () => {
  it("finds each placeholder once, in order", () => {
    expect(extractVariables("{{a}} then {{b}} then {{a}}")).toEqual(["a", "b"]);
  });

  it("returns an empty array when there are none", () => {
    expect(extractVariables("plain text")).toEqual([]);
  });
});

describe("renderTemplate", () => {
  it("substitutes supplied values", () => {
    expect(renderTemplate("About {{topic}}", { topic: "Enron" }, [topic])).toBe(
      "About Enron",
    );
  });

  it("falls back to defaultValue", () => {
    expect(renderTemplate("Tone: {{tone}}", {}, [tone])).toBe("Tone: neutral");
  });

  it("throws when a required variable has no value", () => {
    expect(() => renderTemplate("About {{topic}}", {}, [topic])).toThrow(
      /topic/,
    );
  });

  it("leaves unknown placeholders untouched so typos stay visible", () => {
    expect(renderTemplate("{{typo}}", {}, [])).toBe("{{typo}}");
  });
});
