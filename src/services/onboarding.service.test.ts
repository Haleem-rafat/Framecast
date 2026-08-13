import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

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

/** Minimal DRAFT video with an active script version — what approveScript requires. */
async function createApprovableVideo(projectId: string) {
  const video = await videoService.create(userId, {
    projectId,
    title: "Ready for approval",
    topic: "onboarding test topic",
  });

  const script = await prisma.script.create({ data: { videoId: video.id } });
  const version = await prisma.scriptVersion.create({
    data: { scriptId: script.id, version: 1, content: "Full script content." },
  });
  await prisma.script.update({
    where: { id: script.id },
    data: { activeVersionId: version.id },
  });

  return video.id;
}

describe("onboardingService.getChecklist", () => {
  it("is entirely incomplete for a brand-new user", async () => {
    const checklist = await onboardingService.getChecklist(userId);

    expect(checklist.isComplete).toBe(false);
    expect(checklist.steps.map((s) => s.id)).toEqual([
      "connect-channel",
      "add-narration-key",
      "check-prompt-template",
      "create-project",
      "create-video",
      "generate-script",
      "approve-script",
    ]);
    expect(checklist.steps.every((s) => !s.complete)).toBe(true);
  });

  it("flips connect-channel independently of the other steps", async () => {
    await channelService.connect(userId, {
      youtubeChannelId: `UC_onboarding_${RUN}`,
      title: "Test Channel",
      accessToken: "ya29.test",
      refreshToken: "1//test",
      expiresInSeconds: 3600,
      scopes: ["https://www.googleapis.com/auth/youtube.upload"],
    });

    const checklist = await onboardingService.getChecklist(userId);
    const byId = Object.fromEntries(checklist.steps.map((s) => [s.id, s.complete]));

    expect(byId["connect-channel"]).toBe(true);
    expect(byId["create-project"]).toBe(false);
    expect(checklist.isComplete).toBe(false);
  });

  it("only a default SCRIPT prompt template satisfies check-prompt-template", async () => {
    // A non-default SCRIPT template should not count.
    await promptTemplateService.create(userId, {
      name: `Draft prompt ${RUN}`,
      category: "SCRIPT",
      content: "Write a script about {{topic}}.",
      isDefault: false,
      variables: [],
    });
    expect(
      (await onboardingService.getChecklist(userId)).steps.find(
        (s) => s.id === "check-prompt-template",
      )?.complete,
    ).toBe(false);

    // A default template in a different category should not count either.
    await promptTemplateService.create(userId, {
      name: `Default thumbnail prompt ${RUN}`,
      category: "THUMBNAIL",
      content: "Design a thumbnail for {{topic}}.",
      isDefault: true,
      variables: [],
    });
    expect(
      (await onboardingService.getChecklist(userId)).steps.find(
        (s) => s.id === "check-prompt-template",
      )?.complete,
    ).toBe(false);

    // A default SCRIPT template is what the step actually checks for.
    await promptTemplateService.create(userId, {
      name: `Default script prompt ${RUN}`,
      category: "SCRIPT",
      content: "Write a script about {{topic}}.",
      isDefault: true,
      variables: [],
    });
    expect(
      (await onboardingService.getChecklist(userId)).steps.find(
        (s) => s.id === "check-prompt-template",
      )?.complete,
    ).toBe(true);
  });

  it("completes every step and reports isComplete once a script is approved", async () => {
    await channelService.connect(userId, {
      youtubeChannelId: `UC_onboarding_full_${RUN}`,
      title: "Test Channel",
      accessToken: "ya29.test",
      refreshToken: "1//test",
      expiresInSeconds: 3600,
      scopes: ["https://www.googleapis.com/auth/youtube.upload"],
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
    const videoId = await createApprovableVideo(project.id);

    const beforeApproval = await onboardingService.getChecklist(userId);
    expect(beforeApproval.isComplete).toBe(false);
    expect(
      beforeApproval.steps.find((s) => s.id === "generate-script")?.complete,
    ).toBe(true);
    expect(
      beforeApproval.steps.find((s) => s.id === "approve-script")?.complete,
    ).toBe(false);

    await videoService.approveScript(userId, videoId);

    const afterApproval = await onboardingService.getChecklist(userId);
    expect(afterApproval.steps.every((s) => s.complete)).toBe(true);
    expect(afterApproval.isComplete).toBe(true);
  });
});
