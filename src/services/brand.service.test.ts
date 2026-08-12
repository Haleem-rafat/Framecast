import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { DEFAULT_STYLE } from "@/lib/video-style";
import { brandService } from "@/services/brand.service";
import { channelService } from "@/services/channel.service";
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
