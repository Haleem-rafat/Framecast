import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CHECKLIST_KEY,
  TOUR_KEY,
  helpKey,
} from "@/features/onboarding/dismissal";
import { prisma } from "@/lib/prisma";
import { channelService } from "@/services/channel.service";
import { onboardingService } from "@/services/onboarding.service";
import { projectService } from "@/services/project.service";
import { providerCredentialService } from "@/services/provider-credential.service";
import { promptTemplateService } from "@/services/prompt-template.service";
import { videoService } from "@/services/video.service";

// Tests run against a real, shared Postgres database (see src/test/setup.ts).
// Rather than reuse the shared dev user (whose channel/project/video counts
// this file can't control), each test gets its own fresh, run-tagged User —
// deleting it cascades away every fixture the test created, so cleanup is
// exact and no other file's or the operator's rows are ever touched.
const RUN = randomUUID().slice(0, 8);

let userId: string;

async function makeUser() {
  const user = await prisma.user.create({
    data: {
      name: `onboarding-test-${RUN}`,
      email: `onboarding-test-${RUN}-${randomUUID()}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function cleanup() {
  if (!userId) return;
  await prisma.user.deleteMany({ where: { id: userId } });
}

beforeEach(async () => {
  userId = await makeUser();
});

afterEach(cleanup);
// Belt and suspenders in case a test throws before its own cleanup runs.
afterAll(async () => {
  await prisma.user.deleteMany({
    where: { name: `onboarding-test-${RUN}` },
  });
});

async function connectChannel(suffix: string) {
  return channelService.connect(userId, {
    youtubeChannelId: `UC_onboarding_${suffix}_${RUN}`,
    title: "Test Channel",
    accessToken: "ya29.test",
    refreshToken: "1//test",
    expiresInSeconds: 3600,
    scopes: ["https://www.googleapis.com/auth/youtube.upload"],
  });
}

async function completeOf(id: string): Promise<boolean> {
  const checklist = await onboardingService.getChecklist(userId);
  return checklist.steps.find((step) => step.id === id)?.complete ?? false;
}

describe("onboardingService.getChecklist", () => {
  it("is entirely incomplete for a brand-new user", async () => {
    const checklist = await onboardingService.getChecklist(userId);

    expect(checklist.isComplete).toBe(false);
    expect(checklist.completedCount).toBe(0);
    // Ordered as the app actually imposes them, and the first four ids are
    // read back by AutomationService.getBlockers — renaming one there empties
    // a gate, so the names are asserted rather than the count.
    expect(checklist.steps.map((s) => s.id)).toEqual([
      "connect-channel",
      "describe-brand",
      "add-narration-key",
      "check-prompt-template",
      "create-project",
      "make-video",
      "publish-video",
    ]);
    expect(checklist.steps.every((s) => !s.complete)).toBe(true);
  });

  it("reads real state rather than a stored list of ticks", async () => {
    // Nothing in this test marks a step done. It connects a channel, and the
    // checklist notices — which is the whole property: there is no table of
    // completed steps to get out of step with the account.
    await connectChannel("independent");

    const checklist = await onboardingService.getChecklist(userId);
    const byId = Object.fromEntries(checklist.steps.map((s) => [s.id, s.complete]));

    expect(byId["connect-channel"]).toBe(true);
    expect(byId["create-project"]).toBe(false);
    expect(checklist.completedCount).toBe(1);
    expect(checklist.isComplete).toBe(false);
  });

  it("sends the branding step at the channel it is about, once there is one", async () => {
    const before = await onboardingService.getChecklist(userId);
    expect(before.steps.find((s) => s.id === "describe-brand")?.href).toBe(
      "/channels",
    );

    const channel = await connectChannel("brand-href");

    const after = await onboardingService.getChecklist(userId);
    expect(after.steps.find((s) => s.id === "describe-brand")?.href).toBe(
      `/channels/${channel.id}`,
    );
  });

  it("does not count a ChannelBrand row that says nothing about the channel", async () => {
    const channel = await connectChannel("brand");

    // The brand form upserts a row the first time *any* group on that screen
    // is saved, so a channel whose colours were picked has a row and has said
    // nothing about what it is about.
    await prisma.channelBrand.create({
      data: { channelId: channel.id, primaryColour: "#ff0000" },
    });
    expect(await completeOf("describe-brand")).toBe(false);

    await prisma.channelBrand.update({
      where: { channelId: channel.id },
      data: { niche: "home espresso" },
    });
    expect(await completeOf("describe-brand")).toBe(true);
  });

  it("counts a tone on its own, not just a niche", async () => {
    const channel = await connectChannel("tone");

    await prisma.channelBrand.create({
      data: { channelId: channel.id, tone: "dry and precise" },
    });

    expect(await completeOf("describe-brand")).toBe(true);
  });

  it("only a default SCRIPT prompt satisfies check-prompt-template", async () => {
    // A non-default SCRIPT template should not count.
    await promptTemplateService.create(userId, {
      name: `Draft prompt ${RUN}`,
      category: "SCRIPT",
      content: "Write a script about {{topic}}.",
      isDefault: false,
      variables: [],
    });
    expect(await completeOf("check-prompt-template")).toBe(false);

    // A default template in a different category should not count either.
    await promptTemplateService.create(userId, {
      name: `Default thumbnail prompt ${RUN}`,
      category: "THUMBNAIL",
      content: "Design a thumbnail for {{topic}}.",
      isDefault: true,
      variables: [],
    });
    expect(await completeOf("check-prompt-template")).toBe(false);

    // A default SCRIPT template is what the step actually checks for.
    await promptTemplateService.create(userId, {
      name: `Default script prompt ${RUN}`,
      category: "SCRIPT",
      content: "Write a script about {{topic}}.",
      isDefault: true,
      variables: [],
    });
    expect(await completeOf("check-prompt-template")).toBe(true);
  });

  it("counts only a publication that actually reached YouTube", async () => {
    const channel = await connectChannel("publish");
    const project = await projectService.create(userId, {
      name: `Publish project ${RUN}`,
    });
    const video = await videoService.create(userId, {
      projectId: project.id,
      title: "Something to publish",
      topic: "onboarding test topic",
    });

    // A FAILED row is kept forever as the record that an attempt happened, so
    // "a Publication exists" would tick the last step of onboarding on the
    // strength of an upload that never landed.
    const publication = await prisma.publication.create({
      data: {
        videoId: video.id,
        channelId: channel.id,
        title: "Something to publish",
        status: "FAILED",
      },
    });
    expect(await completeOf("publish-video")).toBe(false);

    await prisma.publication.update({
      where: { id: publication.id },
      data: { status: "PUBLISHED", publishedAt: new Date() },
    });
    expect(await completeOf("publish-video")).toBe(true);
  });

  it("completes every step and reports isComplete once a video is live", async () => {
    const channel = await connectChannel("full");
    await prisma.channelBrand.create({
      data: { channelId: channel.id, niche: "kitchen science", tone: "warm" },
    });
    // A throwaway key on a throwaway user — never the operator's real one.
    await providerCredentialService.upsert(userId, {
      provider: "ELEVENLABS",
      apiKey: `sk-onboarding-${RUN}`,
      label: RUN,
    });
    await promptTemplateService.create(userId, {
      name: `Default script prompt full ${RUN}`,
      category: "SCRIPT",
      content: "Write a script about {{topic}}.",
      isDefault: true,
      variables: [],
    });
    const project = await projectService.create(userId, {
      name: `Onboarding project ${RUN}`,
    });
    const video = await videoService.create(userId, {
      projectId: project.id,
      title: "The last step",
      topic: "onboarding test topic",
    });

    const beforePublish = await onboardingService.getChecklist(userId);
    expect(beforePublish.isComplete).toBe(false);
    expect(beforePublish.completedCount).toBe(6);
    expect(
      beforePublish.steps.find((s) => s.id === "make-video")?.complete,
    ).toBe(true);

    await prisma.publication.create({
      data: {
        videoId: video.id,
        channelId: channel.id,
        title: "The last step",
        status: "PUBLISHED",
        publishedAt: new Date(),
      },
    });

    const afterPublish = await onboardingService.getChecklist(userId);
    expect(afterPublish.steps.every((s) => s.complete)).toBe(true);
    expect(afterPublish.completedCount).toBe(afterPublish.steps.length);
    expect(afterPublish.isComplete).toBe(true);
  });
});

describe("onboardingService progress", () => {
  it("starts with nothing dismissed and writes no row to find that out", async () => {
    expect(await onboardingService.getProgress(userId)).toEqual({
      dismissed: [],
    });

    // Reading is not consent to write — the same rule SettingsService.get
    // follows, and the reason a page load does not create a UserSetting.
    expect(
      await prisma.userSetting.findUnique({ where: { userId } }),
    ).toBeNull();
  });

  it("does not show something again once it has been dismissed", async () => {
    await onboardingService.dismiss(userId, TOUR_KEY);

    // Re-read from the database rather than trusting the return value: the
    // point of the column is that the next page render, in another tab or on
    // another device, sees this.
    const { dismissed } = await onboardingService.getProgress(userId);
    expect(dismissed).toContain(TOUR_KEY);
  });

  it("creates the settings row for an operator who never saved a setting", async () => {
    await onboardingService.dismiss(userId, helpKey("channels"));

    const row = await prisma.userSetting.findUnique({ where: { userId } });
    expect(row?.onboardingSeen).toEqual([helpKey("channels")]);
  });

  it("cannot be made to grow without bound by a repeated dismissal", async () => {
    // Dismissal is fire-and-forget from the browser, so a double click, a
    // retry, or two tabs closing the same note all reach the server.
    await onboardingService.dismiss(userId, TOUR_KEY);
    await onboardingService.dismiss(userId, TOUR_KEY);
    await onboardingService.dismiss(userId, TOUR_KEY);

    expect((await onboardingService.getProgress(userId)).dismissed).toEqual([
      TOUR_KEY,
    ]);
  });

  it("accumulates independent keys", async () => {
    await onboardingService.dismiss(userId, TOUR_KEY);
    await onboardingService.dismiss(userId, CHECKLIST_KEY);
    await onboardingService.dismiss(userId, helpKey("videos"));

    expect(
      (await onboardingService.getProgress(userId)).dismissed.sort(),
    ).toEqual([CHECKLIST_KEY, TOUR_KEY, helpKey("videos")].sort());
  });

  it("replays exactly what was asked for", async () => {
    await onboardingService.dismiss(userId, TOUR_KEY);
    await onboardingService.dismiss(userId, helpKey("videos"));
    await onboardingService.dismiss(userId, helpKey("channels"));

    await onboardingService.restore(userId, [helpKey("videos")]);

    const { dismissed } = await onboardingService.getProgress(userId);
    expect(dismissed.sort()).toEqual([TOUR_KEY, helpKey("channels")].sort());
  });

  it("replays everything when told to", async () => {
    await onboardingService.dismiss(userId, TOUR_KEY);
    await onboardingService.dismiss(userId, CHECKLIST_KEY);
    await onboardingService.dismiss(userId, helpKey("admin"));

    await onboardingService.restore(userId);

    expect((await onboardingService.getProgress(userId)).dismissed).toEqual([]);
  });

  it("restoring nothing does not create a row for someone with no row", async () => {
    await onboardingService.restore(userId);

    expect(
      await prisma.userSetting.findUnique({ where: { userId } }),
    ).toBeNull();
  });

  it("keeps one operator's progress out of another's", async () => {
    const otherId = await makeUser();

    try {
      await onboardingService.dismiss(userId, TOUR_KEY);

      expect(await onboardingService.getProgress(otherId)).toEqual({
        dismissed: [],
      });
    } finally {
      await prisma.user.deleteMany({ where: { id: otherId } });
    }
  });
});
