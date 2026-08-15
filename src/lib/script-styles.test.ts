import { describe, expect, it } from "vitest";

import { extractVariables, renderTemplate } from "@/lib/prompt-template";
import {
  findScriptStyle,
  SCRIPT_STYLES,
  SEEDED_SCRIPT_STYLE_ID,
} from "@/lib/script-styles";

/**
 * The catalogue is data, so these are the assertions that would otherwise be
 * a reviewer reading five prompts carefully every time one is edited.
 *
 * No database and no network: `SCRIPT_STYLES` is a module-level constant, and
 * every property worth checking about it is a property of the strings.
 */
describe("SCRIPT_STYLES", () => {
  it("ships between four and six styles, with unique ids and unique names", () => {
    expect(SCRIPT_STYLES.length).toBeGreaterThanOrEqual(4);
    expect(SCRIPT_STYLES.length).toBeLessThanOrEqual(6);

    // Names have to be unique because they land on `@@unique([userId, name])`
    // — two styles sharing one would make the second un-addable for anybody
    // who added the first.
    const ids = SCRIPT_STYLES.map((style) => style.id);
    const names = SCRIPT_STYLES.map((style) => style.name);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it("declares every placeholder its content references", () => {
    // The failure this exists for has already happened in this project: an
    // undeclared `{{placeholder}}` is left un-substituted by `renderTemplate`
    // (definitions are authoritative), so it reaches the model verbatim and
    // the generated script is about the placeholder.
    for (const style of SCRIPT_STYLES) {
      const declared = new Set(style.variables.map((variable) => variable.key));
      const undeclared = extractVariables(style.content).filter(
        (key) => !declared.has(key),
      );

      expect(
        undeclared,
        `${style.name} references undeclared ${undeclared.join(", ")}`,
      ).toEqual([]);
    }
  });

  it("declares topic on every style, as required", () => {
    for (const style of SCRIPT_STYLES) {
      const topic = style.variables.find((variable) => variable.key === "topic");

      expect(topic, `${style.name} has no topic variable`).toBeDefined();
      expect(topic?.required, `${style.name}'s topic is not required`).toBe(true);
      expect(style.content, `${style.name} never uses {{topic}}`).toContain(
        "{{topic}}",
      );
    }
  });

  it("gives every variable except topic a default, so a bare generate works", () => {
    // `script.service.ts` supplies `topic` from the video and nothing else, so
    // any other variable without a default renders empty (or throws, if it is
    // also required). A style that cannot be generated without the operator
    // filling in a form is a style that does not work from the script panel.
    for (const style of SCRIPT_STYLES) {
      for (const variable of style.variables) {
        if (variable.key === "topic") continue;

        expect(
          variable.defaultValue,
          `${style.name}'s ${variable.key} has no default`,
        ).toBeTruthy();
        expect(
          variable.required ?? false,
          `${style.name}'s ${variable.key} is required but is not topic`,
        ).toBe(false);
      }
    }
  });

  it("renders to a prompt with no placeholders left in it", () => {
    for (const style of SCRIPT_STYLES) {
      const rendered = renderTemplate(
        style.content,
        { topic: "how bridges stay up" },
        style.variables.map((variable) => ({
          key: variable.key,
          required: variable.required ?? false,
          defaultValue: variable.defaultValue ?? null,
        })),
      );

      expect(extractVariables(rendered), `${style.name} left a placeholder`).toEqual(
        [],
      );
      expect(rendered).toContain("how bridges stay up");
    }
  });

  it("keeps every style in the SCRIPT category", () => {
    // The browse surface and `addScriptStyle` both work for any category, but
    // SCRIPT is the only one the application reads today — see
    // scripts/seed-default-prompts.ts's header. A style filed elsewhere would
    // be addable and then have no effect on anything.
    for (const style of SCRIPT_STYLES) {
      expect(style.category).toBe("SCRIPT");
    }
  });

  it("resolves the style the seed script depends on", () => {
    // `seed-default-prompts.ts` throws on a missing id rather than seeding
    // four templates and skipping the only one the app reads. This is the
    // assertion that keeps that throw from ever being reached in production.
    expect(findScriptStyle(SEEDED_SCRIPT_STYLE_ID)).not.toBeNull();
    expect(findScriptStyle("no-such-style")).toBeNull();
  });
});

describe("the children's style", () => {
  const kids = findScriptStyle("childrens-content");

  it("is in the catalogue", () => {
    expect(kids).not.toBeNull();
  });

  it("carries its safety instructions in the prompt itself", () => {
    // Not in a code comment, not in a report — in the string sent to the
    // model. Each of these is a category of harm the brief named, and a
    // rewrite that drops one should fail here rather than ship.
    const content = kids!.content.toLowerCase();

    for (const phrase of [
      "frightening",
      "danger",
      "medicines",
      "cleaning products",
      "stunts",
      "sexual",
      "violent",
      "sarcasm",
      "irony",
    ]) {
      expect(content, `the kids prompt never mentions ${phrase}`).toContain(phrase);
    }
  });

  it("targets a shorter video than the default explainer", () => {
    // The whole point of the length decision: young children get a four
    // minute script, not the nine minute one the house style asks for.
    const kidsDuration = kids!.variables.find(
      (variable) => variable.key === "duration",
    );
    const defaultDuration = findScriptStyle(
      SEEDED_SCRIPT_STYLE_ID,
    )!.variables.find((variable) => variable.key === "duration");

    expect(Number(kidsDuration?.defaultValue)).toBeLessThan(
      Number(defaultDuration?.defaultValue),
    );
    expect(Number(kidsDuration?.defaultValue)).toBe(4);
  });

  it("keeps the sourcing discipline the rest of the catalogue has", () => {
    // An audience that cannot evaluate a claim is the audience least able to
    // survive an invented one.
    expect(kids!.content).toContain("sources field");
    expect(kids!.content.toLowerCase()).toContain("never invent");
  });
});
