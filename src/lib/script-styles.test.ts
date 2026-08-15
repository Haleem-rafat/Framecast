import { describe, expect, it } from "vitest";

import { extractVariables, renderTemplate } from "@/lib/prompt-template";
import {
  findScriptStyle,
  SCRIPT_STYLES,
  SEEDED_SCRIPT_STYLE_ID,
} from "@/lib/script-styles";

/**
 * The catalogue is data, so these are the assertions that would otherwise be
 * a reviewer reading every prompt carefully each time one is edited.
 *
 * No database and no network: `SCRIPT_STYLES` is a module-level constant, and
 * every property worth checking about it is a property of the strings.
 */
describe("SCRIPT_STYLES", () => {
  it("ships a browsable number of styles, with unique ids and unique names", () => {
    // The bounds are about the browse dialog rather than about correctness:
    // the list is read top to bottom before anything is added, and a
    // catalogue nobody scrolls to the end of is a catalogue whose later
    // entries may as well not ship.
    expect(SCRIPT_STYLES.length).toBeGreaterThanOrEqual(4);
    expect(SCRIPT_STYLES.length).toBeLessThanOrEqual(12);

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

describe("the developer styles", () => {
  /**
   * The technical entries, which share two constraints the rest of the
   * catalogue does not have: the renderer cannot show code, and the audience
   * checks claims. Listed here rather than derived from the catalogue so that
   * deleting one fails a test instead of silently shrinking the coverage.
   */
  const DEVELOPER_STYLE_IDS = [
    "system-design-explainer",
    "incident-postmortem",
    "why-it-exists",
    "head-to-head",
    "craft-essay",
  ] as const;

  const developerStyles = DEVELOPER_STYLE_IDS.map((id) => {
    const style = findScriptStyle(id);
    if (!style) throw new Error(`no script style with id "${id}"`);
    return style;
  });

  it("are all in the catalogue, and all in it once", () => {
    const ids = SCRIPT_STYLES.map((style) => style.id);

    for (const id of DEVELOPER_STYLE_IDS) {
      expect(ids.filter((one) => one === id)).toEqual([id]);
    }
  });

  it("tells the model the pipeline cannot show code", () => {
    // The constraint that decides whether any of these is usable. It has to
    // be in the string sent to the model — a comment in the source file does
    // not reach it, and nothing about a topic implies that the footage is
    // stock B-roll the model does not control.
    for (const style of developerStyles) {
      const content = style.content.toLowerCase();

      expect(
        content,
        `${style.name} never says there is no code renderer`,
      ).toContain("no code renderer");
      expect(
        content,
        `${style.name} never says the narration has to stand alone`,
      ).toContain("narration must stand alone");
      expect(
        content,
        `${style.name} never rules out dictating code`,
      ).toContain("never dictate code");
      expect(
        content,
        `${style.name} does not say it is not a tutorial`,
      ).toContain("this is not a tutorial");
    }
  });

  it("carries the accuracy discipline a technical audience needs", () => {
    // Each of these is a way a technical claim goes wrong that the general
    // sourcing rules do not catch: right in the wrong version, right in the
    // wrong year, or a contested question flattened into a confident line.
    for (const style of developerStyles) {
      const content = style.content.toLowerCase();

      for (const phrase of [
        "name versions and dates",
        "well established",
        "disagrees",
        "benchmark",
      ]) {
        expect(content, `${style.name} never mentions ${phrase}`).toContain(
          phrase,
        );
      }
    }
  });

  it("keeps the catalogue's sourcing convention", () => {
    for (const style of developerStyles) {
      expect(style.content, `${style.name} drops the sources field`).toContain(
        "sources field",
      );
      expect(
        style.content.toLowerCase(),
        `${style.name} drops the never-invent rule`,
      ).toContain("never invent");
    }
  });

  it("keeps the voice and cue rules the renderer imposes", () => {
    for (const style of developerStyles) {
      expect(style.content, `${style.name} drops the voice rules`).toContain(
        "read aloud by a synthetic voice",
      );
      expect(style.content, `${style.name} drops the cue rules`).toContain(
        "stock-footage search query",
      );
    }
  });

  it("asks for a length the renderer can actually produce", () => {
    // The arithmetic the whole catalogue runs on: 150 words a minute, and a
    // target length on the browse card that agrees with the duration the
    // prompt will be rendered with.
    for (const style of developerStyles) {
      const duration = Number(
        style.variables.find((variable) => variable.key === "duration")
          ?.defaultValue,
      );

      expect(duration, `${style.name} has no numeric duration`).toBeGreaterThanOrEqual(
        5,
      );
      expect(duration, `${style.name} asks for more than the house style`).toBeLessThanOrEqual(
        10,
      );
      expect(
        style.targetLength,
        `${style.name}'s card says ${style.targetLength} but renders ${duration} minutes`,
      ).toContain(String(duration));
      expect(style.content, `${style.name} never states the word rate`).toContain(
        "150 words a minute",
      );
    }
  });

  it("gives each one a distinct structure rather than one prompt reworded", () => {
    // Five entries whose bodies were near-copies would browse as five
    // choices and produce one video, so each has to name a spine of its own.
    const spines: Record<(typeof DEVELOPER_STYLE_IDS)[number], string> = {
      "system-design-explainer": "trace one single request",
      "incident-postmortem": "Separate the trigger from the cause",
      "why-it-exists": "Then what it displaced",
      "head-to-head": "Then the verdict",
      "craft-essay": "Then the strongest objection",
    };

    for (const style of developerStyles) {
      const spine = spines[style.id as (typeof DEVELOPER_STYLE_IDS)[number]];

      expect(style.content, `${style.name} lost its own spine`).toContain(spine);

      for (const other of developerStyles) {
        if (other.id === style.id) continue;
        expect(
          other.content,
          `${other.name} shares ${style.name}'s structure`,
        ).not.toContain(spine);
      }
    }
  });
});
