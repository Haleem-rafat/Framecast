import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { env } from "@/config/env";
import { NotFoundError, ProviderError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { DEFAULT_STYLE } from "@/lib/video-style";
import {
  CURATED_CATEGORIES,
  PUBLISHING_DEFAULTS,
} from "@/lib/youtube-categories";
import type { UpdateBrandingInput } from "@/schemas/channel.schema";
import { BrandService, brandService, type FetchLike } from "@/services/brand.service";
import { channelService } from "@/services/channel.service";
import { providerCredentialService } from "@/services/provider-credential.service";
import type { SpeechProvider, SpeechVoice } from "@/services/providers/types";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

let userId: string;
let channelId: string;

beforeEach(async () => {
  userId = await createTestUser("brand");
  const channel = await channelService.connect(userId, {
    youtubeChannelId: `UC_${randomUUID().slice(0, 8)}`,
    title: "Test channel",
    accessToken: "ya29.test",
    refreshToken: "1//test",
    expiresInSeconds: 3600,
    scopes: ["https://www.googleapis.com/auth/youtube.upload"],
  });
  channelId = channel.id;
});

afterEach(async () => {
  await deleteTestUser(userId);
});

describe("brandService.resolve", () => {
  it("returns every default when the channel has no brand row", async () => {
    const brand = await brandService.resolve(channelId);

    expect(brand.videoStyle).toEqual(DEFAULT_STYLE);
    expect(brand.logoPath).toBeNull();
  });

  it("returns defaults for a null channel", async () => {
    // A video whose project has no channel assigned still renders.
    const brand = await brandService.resolve(null);
    expect(brand.videoStyle).toEqual(DEFAULT_STYLE);
  });

  it("merges a partial videoStyle over the defaults rather than replacing it", async () => {
    await prisma.channelBrand.create({
      data: { channelId, videoStyle: { transitions: { durationSeconds: 0.25 } } },
    });

    const brand = await brandService.resolve(channelId);

    // The one named value wins; everything unnamed keeps its default, so a
    // brand that sets one field cannot silently blank the rest.
    expect(brand.videoStyle.transitions.durationSeconds).toBe(0.25);
    expect(brand.videoStyle.transitions.enabled).toBe(DEFAULT_STYLE.transitions.enabled);
    expect(brand.videoStyle.captions).toEqual(DEFAULT_STYLE.captions);
  });

  it("ignores a videoStyle that is not an object", async () => {
    // The column is Json; nothing stops a bad write. Rendering with garbage is
    // worse than rendering with defaults.
    await prisma.channelBrand.create({
      data: { channelId: channelId, videoStyle: "not an object" },
    });

    const brand = await brandService.resolve(channelId);
    expect(brand.videoStyle).toEqual(DEFAULT_STYLE);
  });

  it("returns the brand's own text fields when set", async () => {
    await prisma.channelBrand.create({
      data: {
        channelId,
        tone: "dry and factual",
        niche: "business history",
        musicQuery: "calm ambient documentary",
        primaryColour: "#FFCC00",
      },
    });

    const brand = await brandService.resolve(channelId);

    expect(brand.tone).toBe("dry and factual");
    expect(brand.niche).toBe("business history");
    expect(brand.musicQuery).toBe("calm ambient documentary");
    expect(brand.primaryColour).toBe("#FFCC00");
  });

  it("treats a blank musicQuery as unset rather than searching for nothing", async () => {
    // `""` is not null, so it slipped past `??` and became the search term
    // itself — and Jamendo answers an empty `search=` by ignoring it and
    // handing back arbitrary tracks, so those channels got neither the
    // documented fallback nor silence but whatever the catalogue offered.
    // Rows written before `promptText` coerced a cleared box to null still
    // hold exactly this.
    await prisma.channelBrand.create({ data: { channelId, musicQuery: "   " } });

    const brand = await brandService.resolve(channelId);
    expect(brand.musicQuery).toBe("calm ambient instrumental");
  });

  it("discards the whole videoStyle when a leaf has the wrong type", async () => {
    // render.service.ts computes durationSeconds * 2; a string there produces
    // NaN, not a validation error, so this must never reach FFmpeg.
    await prisma.channelBrand.create({
      data: { channelId, videoStyle: { transitions: { durationSeconds: "fast" } } },
    });

    const brand = await brandService.resolve(channelId);
    expect(brand.videoStyle).toEqual(DEFAULT_STYLE);
  });

  it("discards the whole videoStyle when a section is null instead of absent", async () => {
    // The column is Json; a section can be explicitly null rather than
    // simply missing. Null is not "no override" — it fails validation like
    // any other wrong shape and falls back to defaults wholesale.
    await prisma.channelBrand.create({
      data: { channelId, videoStyle: { transitions: null } },
    });

    const brand = await brandService.resolve(channelId);
    expect(brand.videoStyle).toEqual(DEFAULT_STYLE);
  });

  it("says which field it discarded the whole style over", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await prisma.channelBrand.create({
      data: { channelId, videoStyle: { transitions: { durationSeconds: "fast" } } },
    });
    await brandService.resolve(channelId);

    // A discarded style is invisible from the outside: the render, the voice
    // and the captions all come out looking like a channel nobody ever
    // styled, and resolve() cannot throw by design. Without this line "my
    // style isn't applying" is a report with no error, no status and no
    // wrong-looking row behind it.
    const logged = consoleError.mock.calls.flat().join("\n");
    expect(logged).toContain(channelId);
    expect(logged).toContain("transitions.durationSeconds");

    consoleError.mockRestore();
  });

  it("stays quiet for a channel that simply has no style, which is most of them", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    // No brand row at all — `undefined` fails the schema exactly like real
    // garbage does, so logging it would put a line in the render output for
    // every unbranded channel and bury the case worth reading.
    await brandService.resolve(channelId);

    expect(consoleError).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it("strips an unknown key inside an otherwise-valid section", async () => {
    await prisma.channelBrand.create({
      data: {
        channelId,
        videoStyle: { transitions: { durationSeconds: 0.25, madeUpField: "nope" } },
      },
    });

    const brand = await brandService.resolve(channelId);

    expect(brand.videoStyle.transitions.durationSeconds).toBe(0.25);
    expect(brand.videoStyle.transitions).not.toHaveProperty("madeUpField");
  });

  it("never mutates DEFAULT_STYLE through a returned videoStyle", async () => {
    // The no-row path and the unmodified sections on the merge path must not
    // hand back references into DEFAULT_STYLE — otherwise a caller that
    // tweaks its copy in place rewrites the defaults for every channel until
    // the process restarts.
    const brand = await brandService.resolve(channelId);
    brand.videoStyle.captions.fontSize = 999;

    expect(DEFAULT_STYLE.captions.fontSize).not.toBe(999);
  });

  it("resolves to defaults rather than throwing when the lookup fails", async () => {
    // Not a valid UUID, so the query itself throws against the @db.Uuid
    // column instead of simply finding no row — this exercises the "the
    // database call fails" path, not "no brand exists" one.
    const brand = await brandService.resolve("not-a-valid-uuid");
    expect(brand.videoStyle).toEqual(DEFAULT_STYLE);
    expect(brand.logoPath).toBeNull();
  });
});

/** A complete, valid input, so each test can name only the field it is about.
 *  Every field is required on the way in — the branding screen has one Save
 *  and sends all of them. Module-scoped because the narration-voice block
 *  below writes through the same one Save. */
function brandingInput(
  overrides: Partial<UpdateBrandingInput> = {},
): UpdateBrandingInput {
  return {
    channelId,
    stylePreset: null,
    beatSeconds: null,
    primaryColour: "#FFCC00",
    secondaryColour: "#101010",
    headlineFont: "DejaVu Sans",
    tone: "dry and factual",
    niche: "business history",
    musicQuery: "calm ambient documentary",
    characterBrief: null,
    artStyle: null,
    language: "en-GB",
    categoryId: "28",
    madeForKids: false,
    footageStyle: "LIVE_ACTION",
    // Null is the ordinary case, not an omission: it is what a channel that
    // has never chosen a voice sends, and what the picker sends when the
    // operator goes back to the deployment default.
    voiceId: null,
    voiceName: null,
    ...overrides,
  };
}

describe("brandService — branding", () => {

  it("returns en and Education for a channel that has never been branded", async () => {
    // Every channel connected before these columns existed lands here, and
    // has to publish with nothing asked of the operator.
    const branding = await brandService.getBranding(userId, channelId);

    expect(branding).toMatchObject(PUBLISHING_DEFAULTS);
  });

  it("reports an unbranded channel's colours and font as the fallbacks a render would use", async () => {
    // The form's controls cannot represent "unset" — a colour input has to be
    // some colour — so these resolve, and they resolve to exactly what
    // `resolve()` hands the thumbnail compositor for the same channel.
    const branding = await brandService.getBranding(userId, channelId);
    const resolved = await brandService.resolve(channelId);

    expect(branding.primaryColour).toBe(resolved.primaryColour);
    expect(branding.secondaryColour).toBe(resolved.secondaryColour);
    expect(branding.headlineFont).toBe(resolved.headlineFont);
  });

  it("reports the three prompt fields as null until they are chosen", async () => {
    // Unlike the colours: the form has to tell "the operator typed this" apart
    // from "nobody has, so the fallback applies", so it can show the fallback
    // as a placeholder that can be cleared back to.
    const branding = await brandService.getBranding(userId, channelId);

    expect(branding.tone).toBeNull();
    expect(branding.niche).toBeNull();
    expect(branding.musicQuery).toBeNull();
    expect(branding.logoPath).toBeNull();
    expect(branding.updatedAt).toBeNull();
  });

  it("creates the brand row on first save, and updates it afterwards", async () => {
    // Opening this screen and pressing Save is as likely to be an operator's
    // first branding action as choosing a logo is, so this upserts rather than
    // failing on a channel with no row.
    const saved = await brandService.updateBranding(userId, brandingInput());

    expect(saved).toMatchObject({
      primaryColour: "#FFCC00",
      secondaryColour: "#101010",
      headlineFont: "DejaVu Sans",
      tone: "dry and factual",
      niche: "business history",
      musicQuery: "calm ambient documentary",
      language: "en-GB",
      categoryId: "28",
      madeForKids: false,
      footageStyle: "LIVE_ACTION",
    });

    // What the write returned and what a reload reads have to be the same
    // thing, or the screen shows something the database does not hold.
    expect(await brandService.getBranding(userId, channelId)).toEqual(saved);

    const updated = await brandService.updateBranding(
      userId,
      brandingInput({
        primaryColour: "#00FF00",
        headlineFont: "DejaVu Serif",
        language: "pt-BR",
        categoryId: "27",
        madeForKids: true,
        footageStyle: "CARTOON",
      }),
    );

    expect(updated).toMatchObject({
      primaryColour: "#00FF00",
      headlineFont: "DejaVu Serif",
      language: "pt-BR",
      categoryId: "27",
      madeForKids: true,
      footageStyle: "CARTOON",
    });
  });

  it("clears a prompt field back to the documented fallback when it is saved as null", async () => {
    // The only way back to "general interest" once something has been typed —
    // see `promptText` in channel.schema.ts, which maps an emptied box to null.
    await brandService.updateBranding(userId, brandingInput());
    await brandService.updateBranding(
      userId,
      brandingInput({ tone: null, niche: null, musicQuery: null }),
    );

    const branding = await brandService.getBranding(userId, channelId);
    expect(branding.tone).toBeNull();

    // And the render sees the fallback again, not an empty string — which
    // would reach the thumbnail and shorts prompts as a blank.
    const resolved = await brandService.resolve(channelId);
    expect(resolved.tone).toBe("clear and factual");
    expect(resolved.niche).toBe("general interest");
    expect(resolved.musicQuery).toBe("calm ambient instrumental");
  });

  it("leaves the logo and the videoStyle alone when the form saves", async () => {
    // `logoPath` is written by LogoService.choose at the moment an option is
    // picked. Naming it here would let a Save that happened to be in flight
    // put the previous logo back.
    await prisma.channelBrand.create({
      data: {
        channelId,
        logoPath: "logos/one.png",
        videoStyle: { transitions: { durationSeconds: 0.25 } },
      },
    });

    await brandService.updateBranding(userId, brandingInput());

    const brand = await brandService.resolve(channelId);
    expect(brand.logoPath).toBe("logos/one.png");
    expect(brand.videoStyle.transitions.durationSeconds).toBe(0.25);
    expect(brand.language).toBe("en-GB");
    expect(brand.tone).toBe("dry and factual");
  });

  it("refuses to read or write another operator's channel", async () => {
    // Reached straight from a URL, unlike every other read in this service —
    // so ownership is proven here rather than assumed. Defaults for a foreign
    // id would answer "does this channel exist"; NotFoundError does not.
    const otherUserId = await createTestUser("brand-other");

    try {
      await expect(
        brandService.getBranding(otherUserId, channelId),
      ).rejects.toThrow(NotFoundError);

      await expect(
        brandService.updateBranding(otherUserId, brandingInput()),
      ).rejects.toThrow(NotFoundError);

      expect(await prisma.channelBrand.count({ where: { channelId } })).toBe(0);
    } finally {
      await deleteTestUser(otherUserId);
    }
  });

  it("refuses a channel that has been disconnected", async () => {
    // `disconnect` is a soft delete, so the row is still there to be found by
    // an id somebody kept — the scoping has to exclude it explicitly.
    await channelService.disconnect(userId, channelId);

    await expect(
      brandService.getBranding(userId, channelId),
    ).rejects.toThrow(NotFoundError);
  });

  it("lists every branded channel's pair in one lookup, scoped to the operator", async () => {
    const otherUserId = await createTestUser("brand-other");

    try {
      const otherChannel = await channelService.connect(otherUserId, {
        youtubeChannelId: `UC_${randomUUID().slice(0, 8)}`,
        title: "Somebody else's channel",
        accessToken: "ya29.test",
        refreshToken: "1//test",
        expiresInSeconds: 3600,
        scopes: ["https://www.googleapis.com/auth/youtube.upload"],
      });
      await prisma.channelBrand.create({
        data: { channelId: otherChannel.id, language: "fr", categoryId: "24" },
      });
      await prisma.channelBrand.create({
        data: { channelId, language: "en-GB", categoryId: "28" },
      });

      const all = await brandService.listPublishingDefaults(userId);

      // Both rows were created naming only the publishing pair, so the
      // audience declaration and the footage style come back as their column
      // defaults — which is the same answer `getPublishingDefaults` and
      // `resolve` give for a channel with no brand row at all.
      expect(all[channelId]).toEqual({
        language: "en-GB",
        categoryId: "28",
        madeForKids: false,
        footageStyle: "LIVE_ACTION",
      });
      expect(all).not.toHaveProperty(otherChannel.id);
    } finally {
      await deleteTestUser(otherUserId);
    }
  });
});

describe("brandService.listCategories", () => {
  /** The two calls `listCategories` makes, in order: the channel's own
   *  country, then the category list for it. */
  function createCategoryFetch(
    options: { country?: string | null; failList?: boolean } = {},
  ): { fetchImpl: FetchLike; calls: string[] } {
    const calls: string[] = [];

    const fetchImpl: FetchLike = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);

      if (url.includes("/channels?")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [{ snippet: { country: options.country ?? undefined } }],
          }),
        } as unknown as Response;
      }

      if (options.failList) {
        return { ok: false, status: 503, json: async () => ({}) } as unknown as Response;
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            { id: "27", snippet: { title: "Education", assignable: true } },
            { id: "1", snippet: { title: "Film & Animation", assignable: true } },
            // Returned by the same call so old videos filed under it can be
            // read — sending it to videos.insert is a 400 after the whole
            // file has uploaded.
            { id: "18", snippet: { title: "Short Movies", assignable: false } },
          ],
        }),
      } as unknown as Response;
    }) as FetchLike;

    return { fetchImpl, calls };
  }

  it("offers only the categories YouTube marks assignable, for the channel's own region", async () => {
    const { fetchImpl, calls } = createCategoryFetch({ country: "GB" });

    const list = await new BrandService(fetchImpl).listCategories(userId, channelId);

    expect(list.live).toBe(true);
    expect(list.regionCode).toBe("GB");
    expect(calls[1]).toContain("regionCode=GB");
    // Sorted by title — not by the id order YouTube returns, which is
    // meaningless to whoever is reading the list — and the non-assignable
    // entry is gone.
    expect(list.categories).toEqual([
      { id: "27", title: "Education" },
      { id: "1", title: "Film & Animation" },
    ]);
  });

  it("falls back to US when the channel has no country of its own", async () => {
    const { fetchImpl, calls } = createCategoryFetch({ country: null });

    const list = await new BrandService(fetchImpl).listCategories(userId, channelId);

    expect(list.regionCode).toBe("US");
    expect(calls[1]).toContain("regionCode=US");
  });

  it("degrades to the curated list rather than throwing when YouTube is unreachable", async () => {
    // The language half of the same dialog needs no network at all, so an
    // unreachable API must not take the dialog down with it — it says the
    // list is not live instead.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fetchImpl } = createCategoryFetch({ failList: true });

    const list = await new BrandService(fetchImpl).listCategories(userId, channelId);

    expect(list.live).toBe(false);
    expect(list.categories).toEqual([...CURATED_CATEGORIES]);
    // The default has to be offerable by the fallback too, or a channel that
    // opens the dialog offline cannot save what it already has.
    expect(
      list.categories.some(
        (category) => category.id === PUBLISHING_DEFAULTS.categoryId,
      ),
    ).toBe(true);

    consoleError.mockRestore();
  });
});

describe("brandService — narration voice", () => {
  it("falls back to the deployment's voice for a channel that has never chosen one", async () => {
    // The compatibility promise of the whole feature: every channel that
    // existed before this column narrates with exactly the voice it always
    // did, and nobody has to do anything.
    const brand = await brandService.resolve(channelId);

    expect(brand.voiceId).toBe(env.ELEVENLABS_VOICE_ID);
    expect(brand.voiceName).toBeNull();
  });

  it("falls back for a video with no channel at all, and for a lookup that fails", async () => {
    expect((await brandService.resolve(null)).voiceId).toBe(env.ELEVENLABS_VOICE_ID);

    // `resolve` is documented as never throwing; narration now depends on that,
    // because the voice is read from it before a single character is spent.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await brandService.resolve("not-a-uuid")).voiceId).toBe(
      env.ELEVENLABS_VOICE_ID,
    );
    consoleError.mockRestore();
  });

  it("resolves the channel's own voice once one is chosen", async () => {
    await brandService.updateBranding(
      userId,
      brandingInput({ voiceId: "AbC123voice", voiceName: "Charlotte" }),
    );

    const brand = await brandService.resolve(channelId);

    expect(brand.voiceId).toBe("AbC123voice");
    expect(brand.voiceName).toBe("Charlotte");
  });

  it("reports the voice as unchosen to the screen, where the render sees a fallback", async () => {
    // The same split the three prompt fields have, and for the same reason:
    // the picker has to be able to show "the deployment default" as the
    // selected option rather than as a voice the operator appears to have
    // picked out of a list.
    const branding = await brandService.getBranding(userId, channelId);

    expect(branding.voiceId).toBeNull();
    expect(branding.voiceName).toBeNull();
  });

  it("stores the chosen voice and the name it had when it was chosen", async () => {
    const saved = await brandService.updateBranding(
      userId,
      brandingInput({ voiceId: "XyZ789voice", voiceName: "Roger" }),
    );

    expect(saved.voiceId).toBe("XyZ789voice");
    expect(saved.voiceName).toBe("Roger");
    expect(await brandService.getBranding(userId, channelId)).toMatchObject({
      voiceId: "XyZ789voice",
      voiceName: "Roger",
    });
  });

  it("drops the name when the voice goes back to the deployment default", async () => {
    await brandService.updateBranding(
      userId,
      brandingInput({ voiceId: "XyZ789voice", voiceName: "Roger" }),
    );

    // A form that sent a stale name alongside a cleared voice would otherwise
    // leave the narration library printing "Roger" against a voice that is no
    // longer Roger.
    const cleared = await brandService.updateBranding(
      userId,
      brandingInput({ voiceId: null, voiceName: "Roger" }),
    );

    expect(cleared.voiceId).toBeNull();
    expect(cleared.voiceName).toBeNull();
    expect((await brandService.resolve(channelId)).voiceId).toBe(
      env.ELEVENLABS_VOICE_ID,
    );
  });

  it("refuses to set a voice on another operator's channel", async () => {
    const otherUserId = await createTestUser("brand-voice-other");

    try {
      await expect(
        brandService.updateBranding(
          otherUserId,
          brandingInput({ voiceId: "AbC123voice", voiceName: "X" }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    } finally {
      await deleteTestUser(otherUserId);
    }
  });
});

describe("brandService.listVoices", () => {
  /** A speech provider that records the key it was handed. Injected for the
   *  usual reason and one sharper one: the real provider's other method
   *  spends the operator's ElevenLabs allowance. */
  function fakeSpeech(
    behaviour: { voices?: SpeechVoice[]; fail?: boolean } = {},
  ): { provider: SpeechProvider; keys: string[] } {
    const keys: string[] = [];

    return {
      keys,
      provider: {
        synthesize: async () => {
          throw new Error("no test in this file may ever synthesise");
        },
        listVoices: async (apiKey: string) => {
          keys.push(apiKey);
          if (behaviour.fail) {
            throw new ProviderError("ELEVENLABS", "ElevenLabs refused (503).", true);
          }
          return behaviour.voices ?? [];
        },
      },
    };
  }

  const VOICE: SpeechVoice = {
    voiceId: "AbC123voice",
    name: "Charlotte",
    description: "Warm and unhurried",
    labels: [
      { name: "accent", value: "british" },
      { name: "use case", value: "narration" },
    ],
    previewUrl: "https://storage.googleapis.com/eleven/charlotte.mp3",
  };

  it("asks with the operator's own stored key", async () => {
    await providerCredentialService.upsert(userId, {
      provider: "ELEVENLABS",
      apiKey: "sk_operator_key_1234",
    });
    const { provider, keys } = fakeSpeech({ voices: [VOICE] });

    const list = await new BrandService(fetch, provider).listVoices(userId);

    expect(list.status).toBe("ok");
    expect(list.voices).toEqual([VOICE]);
    expect(keys).toEqual(["sk_operator_key_1234"]);
  });

  it("gives each operator their own account's voices, never another's key", async () => {
    const otherUserId = await createTestUser("brand-voices-other");

    try {
      await providerCredentialService.upsert(userId, {
        provider: "ELEVENLABS",
        apiKey: "sk_mine_1111",
      });
      await providerCredentialService.upsert(otherUserId, {
        provider: "ELEVENLABS",
        apiKey: "sk_theirs_2222",
      });
      const { provider, keys } = fakeSpeech({ voices: [VOICE] });
      const service = new BrandService(fetch, provider);

      await service.listVoices(userId);
      await service.listVoices(otherUserId);

      // Each call carried exactly the key of the operator who made it. There
      // is no channel id and nothing else the browser sends that could point
      // this at somebody else's credential.
      expect(keys).toEqual(["sk_mine_1111", "sk_theirs_2222"]);
    } finally {
      await deleteTestUser(otherUserId);
    }
  });

  it("never returns the key in what it hands back", async () => {
    await providerCredentialService.upsert(userId, {
      provider: "ELEVENLABS",
      apiKey: "sk_secret_key_9999",
    });
    const { provider } = fakeSpeech({ voices: [VOICE] });

    const list = await new BrandService(fetch, provider).listVoices(userId);

    // The whole payload, not just the fields anyone thought to check — this
    // travels to the browser through a server action.
    expect(JSON.stringify(list)).not.toContain("sk_secret_key_9999");
  });

  it("says no credential is stored rather than showing an empty account", async () => {
    const { provider, keys } = fakeSpeech({ voices: [VOICE] });

    const list = await new BrandService(fetch, provider).listVoices(userId);

    expect(list).toEqual({ voices: [], status: "no-credential" });
    // Nothing was asked, because there was nothing to ask with.
    expect(keys).toEqual([]);
  });

  it("reports an unreachable ElevenLabs rather than inventing a voice list", async () => {
    // The rule this test exists for: there is no offline catalogue to fall
    // back to. A hardcoded list would offer voices this account may not have,
    // and choosing one of those is a narration that fails after a video has
    // been queued.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await providerCredentialService.upsert(userId, {
      provider: "ELEVENLABS",
      apiKey: "sk_operator_key_1234",
    });
    const { provider } = fakeSpeech({ fail: true });

    const list = await new BrandService(fetch, provider).listVoices(userId);

    expect(list).toEqual({ voices: [], status: "unavailable" });
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain(
      "sk_operator_key_1234",
    );
    consoleError.mockRestore();
  });

  it("treats an account with no voices as an answer, not a failure", async () => {
    await providerCredentialService.upsert(userId, {
      provider: "ELEVENLABS",
      apiKey: "sk_operator_key_1234",
    });
    const { provider } = fakeSpeech({ voices: [] });

    expect(await new BrandService(fetch, provider).listVoices(userId)).toEqual({
      voices: [],
      status: "ok",
    });
  });
});
