import { describe, expect, it } from "vitest";

import { updateBrandingSchema } from "@/schemas/channel.schema";
import { createSeriesSchema } from "@/schemas/series.schema";
import type { AutomationScriptStyle } from "@/services/automation.service";
import type { ChannelBranding } from "@/services/brand.service";

import { findNichePreset, NICHE_PRESETS, resolvePresetStyle } from "./niche-presets";
import {
  applyNichePreset,
  brandChanges,
  chooseChannel,
  displayedCaptionMode,
  firstIncompleteStep,
  initialDraft,
  reconcileDraft,
  toBrandingInput,
  toCreateSeriesInput,
  validateStep,
  WIZARD_STEPS,
  type SeriesDraft,
  type WizardContext,
} from "./series-wizard-state";

/**
 * The wizard's decisions, without a browser or a database.
 *
 * What these protect is the promise the wizard makes on its last screen: that
 * the two payloads it sends are the ones the server contracts already accept,
 * and that a channel setting nobody touched is never written.
 */

const CHANNEL_A = "11111111-1111-4111-8111-111111111111";
const CHANNEL_B = "22222222-2222-4222-8222-222222222222";
const PROJECT_A = "33333333-3333-4333-8333-333333333333";
const PROJECT_B = "44444444-4444-4444-8444-444444444444";
const STYLE_DEFAULT = "55555555-5555-4555-8555-555555555555";
const STYLE_CASE = "66666666-6666-4666-8666-666666666666";

function style(overrides: Partial<AutomationScriptStyle>): AutomationScriptStyle {
  return {
    id: STYLE_DEFAULT,
    name: "Default script",
    isDefault: false,
    fields: [],
    duration: null,
    ...overrides,
  };
}

const scriptStyles: AutomationScriptStyle[] = [
  style({
    id: STYLE_DEFAULT,
    name: "Default script",
    isDefault: true,
    fields: [
      { key: "audience", label: "Audience", defaultValue: "curious viewers", required: false },
      { key: "tone", label: "Tone", defaultValue: "clear", required: false },
    ],
  }),
  style({
    id: STYLE_CASE,
    name: "Case study",
    fields: [
      { key: "audience", label: "Audience", defaultValue: null, required: true },
    ],
  }),
];

function branding(overrides: Partial<ChannelBranding> = {}): ChannelBranding {
  return {
    logoPath: null,
    characterBrief: null,
    characterSheetPath: null,
    artStyle: null,
    stylePreset: null,
    beatSeconds: null,
    primaryColour: "#FFFFFF",
    secondaryColour: "#000000",
    headlineFont: "DejaVu Sans",
    tone: null,
    niche: null,
    musicQuery: null,
    voiceId: null,
    voiceName: null,
    captionMode: null,
    updatedAt: null,
    language: "en",
    categoryId: "27",
    madeForKids: false,
    footageStyle: "LIVE_ACTION",
    ...overrides,
  };
}

function context(overrides: Partial<WizardContext> = {}): WizardContext {
  return {
    setup: {
      channels: [
        { id: CHANNEL_A, title: "Alpha" },
        { id: CHANNEL_B, title: "Beta" },
      ],
      projects: [
        { id: PROJECT_B, name: "Beta shows", channelId: CHANNEL_B },
        { id: PROJECT_A, name: "Alpha shows", channelId: CHANNEL_A },
      ],
      scriptStyles,
    },
    brandings: { [CHANNEL_A]: branding(), [CHANNEL_B]: branding({ voiceId: "abc123" }) },
    ...overrides,
  };
}

/** A draft that has answered every step. */
function completeDraft(ctx = context()): SeriesDraft {
  const preset = findNichePreset("history-stories")!;

  return {
    ...applyNichePreset(initialDraft(ctx), preset, null, scriptStyles),
    timeZone: "Europe/London",
  };
}

describe("initialDraft", () => {
  it("opens on a channel that has a project, with that project and its brand", () => {
    const ctx = context({
      setup: { ...context().setup, projects: [context().setup.projects[0]] },
    });
    const draft = initialDraft(ctx);

    expect(draft.channelId).toBe(CHANNEL_B);
    expect(draft.projectId).toBe(PROJECT_B);
    expect(draft.brand?.voiceId).toBe("abc123");
  });

  it("starts with auto-publish off and nothing chosen for the niche", () => {
    const draft = initialDraft(context());

    expect(draft.autoPublish).toBe(false);
    expect(draft.publishVisibility).toBe("PRIVATE");
    expect(draft.nichePresetId).toBeNull();
    expect(validateStep("niche", draft, context())).not.toBeNull();
  });
});

describe("niche presets", () => {
  it("every preset starts with topics the topic schema accepts", () => {
    for (const preset of NICHE_PRESETS) {
      expect(preset.topics.length).toBeGreaterThan(0);
      for (const topic of preset.topics) {
        expect(topic.trim().length).toBeGreaterThanOrEqual(3);
        expect(topic.length).toBeLessThanOrEqual(300);
      }
    }
  });

  it("resolves to the first preferred style the library has, else the default", () => {
    const history = findNichePreset("history-stories")!;
    const mythology = findNichePreset("mythology")!;

    expect(resolvePresetStyle(history, scriptStyles)?.id).toBe(STYLE_CASE);
    expect(resolvePresetStyle(mythology, scriptStyles)?.id).toBe(STYLE_DEFAULT);
    expect(
      resolvePresetStyle(history, [style({ id: STYLE_DEFAULT, name: "Mine", isDefault: true })])
        ?.id,
    ).toBe(STYLE_DEFAULT);
  });

  it("fills the name, the style, declared variables and the topics", () => {
    const preset = findNichePreset("history-stories")!;
    const draft = applyNichePreset(initialDraft(context()), preset, null, scriptStyles);

    expect(draft.nichePresetId).toBe("history-stories");
    expect(draft.name).toBe(preset.seriesName);
    expect(draft.promptTemplateId).toBe(STYLE_CASE);
    // Case study declares audience but not tone, so tone is not invented.
    expect(draft.variables).toEqual({ audience: preset.variables.audience });
    expect(draft.topicText.split("\n")).toEqual(preset.topics);
  });

  it("never overwrites a name or topics the operator wrote", () => {
    const first = findNichePreset("mythology")!;
    const second = findNichePreset("mysteries")!;
    const picked = applyNichePreset(initialDraft(context()), first, null, scriptStyles);
    const edited = { ...picked, name: "Gods and monsters", topicText: "Medusa" };

    const switched = applyNichePreset(edited, second, first, scriptStyles);

    expect(switched.name).toBe("Gods and monsters");
    expect(switched.topicText).toBe("Medusa");
  });

  it("replaces what an earlier preset filled in and the operator left alone", () => {
    const first = findNichePreset("mythology")!;
    const second = findNichePreset("mysteries")!;
    const picked = applyNichePreset(initialDraft(context()), first, null, scriptStyles);

    const switched = applyNichePreset(picked, second, first, scriptStyles);

    expect(switched.name).toBe(second.seriesName);
    expect(switched.topicText).toBe(second.topics.join("\n"));
    expect(switched.variables.audience).toBe(second.variables.audience);
  });
});

describe("validateStep", () => {
  it("refuses the topics step without a topic, and names missing required answers", () => {
    const draft = completeDraft();

    expect(validateStep("topics", draft, context())).toBeNull();
    expect(validateStep("topics", { ...draft, topicText: "  \n " }, context())).toMatch(
      /at least one topic/,
    );
    expect(
      validateStep("topics", { ...draft, variables: {} }, context()),
    ).toBe("The script style needs: Audience.");
    expect(validateStep("topics", { ...draft, name: " " }, context())).toMatch(/name/);
  });

  it("refuses a project that publishes to a different channel", () => {
    const draft = { ...completeDraft(), channelId: CHANNEL_A, projectId: PROJECT_B };

    expect(validateStep("channel", draft, context())).toMatch(/project/);
  });

  it("asks for an art style on a drawn footage style, and a rhythm on doodle", () => {
    const draft = completeDraft();
    const illustrated = {
      ...draft,
      brand: { ...draft.brand!, footageStyle: "ILLUSTRATED" as const, artStyle: null },
    };
    const doodle = {
      ...draft,
      brand: {
        ...draft.brand!,
        footageStyle: "DOODLE" as const,
        artStyle: "doodle-marker" as const,
        beatSeconds: null,
      },
    };

    expect(validateStep("look", illustrated, context())).toMatch(/art style/);
    expect(validateStep("look", doodle, context())).toMatch(/seconds/);
    expect(
      validateStep("look", { ...doodle, brand: { ...doodle.brand, beatSeconds: 7 } }, context()),
    ).toBeNull();
  });

  it("clamps to the first unanswered step", () => {
    expect(firstIncompleteStep(initialDraft(context()), context())).toBe(0);
    expect(
      WIZARD_STEPS[firstIncompleteStep({ ...completeDraft(), timeZone: "" }, context())].id,
    ).toBe("schedule");
    expect(WIZARD_STEPS[firstIncompleteStep(completeDraft(), context())].id).toBe("review");
  });
});

describe("payloads", () => {
  it("builds a create payload the server schema accepts", () => {
    const input = toCreateSeriesInput({
      ...completeDraft(),
      frequency: "MONTHLY",
      dayOfMonth: 31,
      time: "18:45",
    });

    expect(createSeriesSchema.safeParse(input).success).toBe(true);
    expect(input).toMatchObject({ dayOfWeek: null, dayOfMonth: 31, hour: 18, minute: 45 });
    expect(validateStep("review", completeDraft(), context())).toBeNull();
  });

  it("drops blank variable answers so the style's own default applies", () => {
    const input = toCreateSeriesInput({
      ...completeDraft(),
      variables: { audience: "adults", tone: "   " },
    });

    expect(input.variables).toEqual({ audience: "adults" });
  });

  it("reports no brand changes, and so no brand write, when nothing was touched", () => {
    const ctx = context();
    const draft = completeDraft(ctx);

    expect(brandChanges(draft, ctx.brandings[draft.channelId])).toEqual([]);
  });

  it("sends the channel's untouched fields back as they were", () => {
    const ctx = context({
      brandings: {
        [CHANNEL_A]: branding({
          tone: "wry",
          madeForKids: true,
          headlineFont: "Not A Real Font",
          stylePreset: "insight-short",
        }),
        [CHANNEL_B]: branding(),
      },
    });
    const draft = completeDraft(ctx);
    const changed = {
      ...draft,
      brand: { ...draft.brand!, musicQuery: "dark ambient" },
    };
    const input = toBrandingInput(changed, ctx.brandings[CHANNEL_A]);

    expect(brandChanges(changed, ctx.brandings[CHANNEL_A])).toEqual(["music"]);
    expect(input).toMatchObject({
      channelId: CHANNEL_A,
      tone: "wry",
      madeForKids: true,
      stylePreset: "insight-short",
      musicQuery: "dark ambient",
    });
    expect(updateBrandingSchema.safeParse(input).success).toBe(true);
  });

  it("writes a caption mode only when it differs from what the channel inherits", () => {
    const ctx = context();
    const draft = completeDraft(ctx);
    const channel = ctx.brandings[draft.channelId];

    // LIVE_ACTION inherits srt; choosing srt again is not a change.
    const same = { ...draft, brand: { ...draft.brand!, captionMode: "srt" as const } };
    const kinetic = { ...draft, brand: { ...draft.brand!, captionMode: "kinetic" as const } };

    expect(toBrandingInput(same, channel).captionMode).toBeUndefined();
    expect(toBrandingInput(kinetic, channel).captionMode).toBe("kinetic");
    expect(brandChanges(kinetic, channel)).toEqual(["captions"]);
  });

  it("moves the displayed caption default with the footage style until one is picked", () => {
    const ctx = context();
    const draft = completeDraft(ctx);
    const doodle = {
      ...draft,
      brand: { ...draft.brand!, footageStyle: "DOODLE" as const },
    };

    expect(displayedCaptionMode(draft, ctx)).toBe("srt");
    expect(displayedCaptionMode(doodle, ctx)).toBe("kinetic");
  });
});

describe("chooseChannel and reconcileDraft", () => {
  it("re-reads the brand and the project when the channel changes", () => {
    const ctx = context();
    const draft = completeDraft(ctx);
    const edited = { ...draft, brand: { ...draft.brand!, musicQuery: "lofi" } };

    expect(draft.channelId).toBe(CHANNEL_A);

    const moved = chooseChannel(edited, CHANNEL_B, ctx);

    expect(moved.projectId).toBe(PROJECT_B);
    expect(moved.brand?.musicQuery).toBeNull();
    expect(moved.brand?.voiceId).toBe("abc123");
  });

  it("drops a restored channel that no longer exists", () => {
    const ctx = context();
    const restored = reconcileDraft(
      { ...completeDraft(ctx), channelId: "77777777-7777-4777-8777-777777777777" },
      ctx,
    );

    expect(ctx.setup.channels.map((channel) => channel.id)).toContain(restored.channelId);
  });

  it("re-reads a restored brand the branding screen has saved over since", () => {
    const ctx = context();
    const draft = completeDraft(ctx);
    const stale = { ...draft, brand: { ...draft.brand!, musicQuery: "lofi" } };
    const later = context({
      brandings: {
        ...ctx.brandings,
        [draft.channelId]: branding({ voiceId: "abc123", updatedAt: new Date("2026-09-01") }),
      },
    });

    expect(reconcileDraft(stale, ctx).brand?.musicQuery).toBe("lofi");
    expect(reconcileDraft(stale, later).brand?.musicQuery).toBeNull();
  });
});
