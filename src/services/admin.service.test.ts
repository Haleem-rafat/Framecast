import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encryptSecret } from "@/lib/crypto";
import { NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { adminService } from "@/services/admin.service";
import { projectService } from "@/services/project.service";
import { providerCredentialService } from "@/services/provider-credential.service";
import { videoService } from "@/services/video.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

/**
 * The admin read path, and the promise it is only worth having if it holds:
 * that cross-user data is reachable *here and nowhere else*.
 *
 * Tests run against the shared Postgres that also holds the operator's real
 * rows, so every assertion is made about *this file's* ids rather than about
 * raw list lengths — `listUsers` legitimately returns every account in the
 * database, including real ones.
 */

let operatorId: string;
let subjectId: string;
let projectId: string;
let videoId: string;
let channelId: string;

/**
 * A plausible secret. Real AES-256-GCM ciphertext rather than a placeholder,
 * because the assertion these tests make is that no admin payload contains it
 * — and a fake would pass that assertion for the wrong reason.
 */
const SECRET_KEY = "sk-test-DO-NOT-LEAK-4242424242424242";
const OAUTH_ACCESS_TOKEN = "ya29.test-access-DO-NOT-LEAK";
const OAUTH_REFRESH_TOKEN = "1//test-refresh-DO-NOT-LEAK";

beforeEach(async () => {
  operatorId = await createTestUser("admin-operator");
  subjectId = await createTestUser("admin-subject");

  await prisma.user.update({
    where: { id: operatorId },
    data: { approval: "APPROVED", approvedAt: new Date(), role: "OPERATOR" },
  });
  await prisma.user.update({
    where: { id: subjectId },
    data: { approval: "APPROVED", approvedAt: new Date() },
  });

  const channel = await prisma.channel.create({
    data: {
      userId: subjectId,
      youtubeChannelId: `UC-${randomUUID()}`,
      title: "Subject's channel",
      accessToken: OAUTH_ACCESS_TOKEN,
      refreshToken: OAUTH_REFRESH_TOKEN,
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: ["https://www.googleapis.com/auth/youtube.upload"],
    },
  });
  channelId = channel.id;

  const project = await prisma.project.create({
    data: { userId: subjectId, name: "Subject's project", channelId },
  });
  projectId = project.id;

  const video = await prisma.video.create({
    data: {
      userId: subjectId,
      projectId,
      title: "Subject's video",
      status: "RENDERING",
      // A lease an hour in the past: the worker holding it died. This is the
      // "why is their video stuck" case the detail view exists to surface.
      leaseExpiresAt: new Date(Date.now() - 3_600_000),
      attempts: 2,
    },
  });
  videoId = video.id;

  await prisma.providerCredential.create({
    data: {
      userId: subjectId,
      provider: "ELEVENLABS",
      label: "Subject's narration key",
      encryptedKey: encryptSecret(SECRET_KEY),
      keyLastFour: SECRET_KEY.slice(-4),
    },
  });
});

afterEach(async () => {
  await deleteTestUser(subjectId);
  await deleteTestUser(operatorId);
});

describe("adminService.listUsers", () => {
  it("returns accounts the caller does not own, which no other service will do", async () => {
    const users = await adminService.listUsers(operatorId);
    const subject = users.find((user) => user.id === subjectId);

    expect(subject).toBeDefined();
    expect(subject?.email).toContain("@framecast.invalid");
    expect(subject?.role).toBe("MEMBER");
    expect(subject?.approval).toBe("APPROVED");
  });

  it("counts what the account is working on, excluding soft-deleted rows", async () => {
    await prisma.video.update({
      where: { id: videoId },
      data: { deletedAt: new Date() },
    });

    const subject = (await adminService.listUsers(operatorId)).find(
      (user) => user.id === subjectId,
    );

    expect(subject?.projectCount).toBe(1);
    expect(subject?.channelCount).toBe(1);
    // Soft-deleted: the operator is asking what this person is doing, not
    // what they have ever done.
    expect(subject?.videoCount).toBe(0);
  });

  it("reports an account that has registered and never acted", async () => {
    const subject = (await adminService.listUsers(operatorId)).find(
      (user) => user.id === subjectId,
    );

    expect(subject?.lastActiveAt).toBeNull();
  });
});

describe("adminService.getUser", () => {
  it("hands back another account's projects, videos, channels and publications", async () => {
    const detail = await adminService.getUser(operatorId, subjectId);

    expect(detail.user.id).toBe(subjectId);
    expect(detail.projects.map((one) => one.id)).toContain(projectId);
    expect(detail.videos.map((one) => one.id)).toContain(videoId);
    expect(detail.channels.map((one) => one.id)).toContain(channelId);
    expect(detail.credentials.map((one) => one.provider)).toContain(
      "ELEVENLABS",
    );
  });

  it("carries enough about a stuck video to explain it without psql", async () => {
    const detail = await adminService.getUser(operatorId, subjectId);
    const video = detail.videos.find((one) => one.id === videoId);

    expect(video?.status).toBe("RENDERING");
    expect(video?.attempts).toBe(2);
    // The lease is in the past, so the row is claimable and unclaimed — a
    // different problem from a render genuinely in progress.
    expect(video?.leaseExpiresAt?.getTime()).toBeLessThan(Date.now());
  });

  it("refuses an id with no account rather than returning an empty shell", async () => {
    await expect(
      adminService.getUser(operatorId, randomUUID()),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

/**
 * The rule that makes the separation worth anything: adding an admin view must
 * not have widened a single existing query.
 */
describe("the ordinary scoped services after the admin service exists", () => {
  it("still refuse a foreign video id", async () => {
    // Refused by throwing, not by returning null — `videoService.get` filters
    // on `{ id, userId }` and treats a miss as a 404. An operator asking for
    // somebody else's video through the ordinary service gets the same answer
    // as someone asking for a video that does not exist, which is right: the
    // role is not a key to these methods.
    await expect(videoService.get(operatorId, videoId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("still refuse to list a foreign account's projects", async () => {
    const projects = await projectService.list(operatorId);
    expect(projects.map((one) => one.id)).not.toContain(projectId);
  });

  it("still refuse to list a foreign account's credentials", async () => {
    const credentials = await providerCredentialService.list(operatorId);
    expect(credentials.map((one) => one.provider)).not.toContain("ELEVENLABS");
  });

  it("refuse the operator exactly as they refuse anybody — the role buys nothing here", async () => {
    // There is no `isOperator` bypass inside the scoped services, so being an
    // OPERATOR makes no difference to any of them. If someone ever threads
    // one through, this is the test that goes red.
    const memberId = await createTestUser("admin-bystander");

    try {
      const asOperator = await videoService
        .get(operatorId, videoId)
        .then(() => "allowed")
        .catch((error: unknown) => (error as Error).constructor.name);
      const asMember = await videoService
        .get(memberId, videoId)
        .then(() => "allowed")
        .catch((error: unknown) => (error as Error).constructor.name);

      expect(asOperator).toBe("NotFoundError");
      expect(asOperator).toBe(asMember);
    } finally {
      await deleteTestUser(memberId);
    }
  });
});

describe("the audit record", () => {
  it("is written when an operator opens somebody else's account", async () => {
    const before = new Date();

    await adminService.getUser(operatorId, subjectId);

    const log = await prisma.activityLog.findFirstOrThrow({
      where: { action: "admin.user.view", entityId: subjectId },
    });

    // Who looked, whose it was, and when — the three things a user asking
    // "was my data accessed" needs answered.
    expect(log.userId).toBe(operatorId);
    expect(log.entityType).toBe("User");
    expect(log.entityId).toBe(subjectId);
    expect(log.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    // WARN, not INFO: this is one person reading another's records, and it
    // should surface in a level filter without knowing the action name.
    expect(log.level).toBe("WARN");
  });

  it("answers the question from the subject's end, not just the operator's", async () => {
    await adminService.getUser(operatorId, subjectId);

    // The form the answer takes when a user asks. Indexed by
    // ActivityLog(entityType, entityId).
    const viewers = await prisma.activityLog.findMany({
      where: {
        entityType: "User",
        entityId: subjectId,
        action: "admin.user.view",
      },
      select: { userId: true },
    });

    expect(viewers.map((row) => row.userId)).toEqual([operatorId]);
  });

  it("is not written when an operator opens their own account", async () => {
    await adminService.getUser(operatorId, operatorId);

    const logs = await prisma.activityLog.count({
      where: { action: "admin.user.view", entityId: operatorId },
    });

    // Their own data. There is no access to account for, and logging it would
    // bury the cross-user rows that matter.
    expect(logs).toBe(0);
  });

  it("records the roster read too, since the list is every account's name and email", async () => {
    await adminService.listUsers(operatorId);

    const log = await prisma.activityLog.findFirstOrThrow({
      where: { userId: operatorId, action: "admin.users.list" },
    });

    // No entityId — there is no single subject — which also keeps it out of
    // the per-subject query above.
    expect(log.entityId).toBeNull();
  });

  it("writes nothing for an account that does not exist", async () => {
    await expect(
      adminService.getUser(operatorId, randomUUID()),
    ).rejects.toBeInstanceOf(NotFoundError);

    const logs = await prisma.activityLog.count({
      where: { userId: operatorId, action: "admin.user.view" },
    });
    expect(logs).toBe(0);
  });
});

/**
 * The assertion the whole admin surface is judged on. Serialise the entire
 * payload and look for the secrets by value — a field-by-field allowlist would
 * pass a payload that smuggled a token through a nested relation nobody
 * enumerated.
 */
describe("secrets in the admin payload", () => {
  it("contains no credential ciphertext, plaintext or last four", async () => {
    const detail = await adminService.getUser(operatorId, subjectId);
    const serialized = JSON.stringify(detail);

    const stored = await prisma.providerCredential.findFirstOrThrow({
      where: { userId: subjectId },
      select: { encryptedKey: true, keyLastFour: true },
    });

    expect(serialized).not.toContain(SECRET_KEY);
    expect(serialized).not.toContain(stored.encryptedKey);
    // Four characters of a real key, and the operator's own /providers page is
    // the only place with a reason to show them.
    expect(serialized).not.toContain(stored.keyLastFour);

    // But the credential is still *visible as existing*, which is the whole
    // point — it is what explains a failing render.
    const credential = detail.credentials.find(
      (one) => one.provider === "ELEVENLABS",
    );
    expect(credential?.label).toBe("Subject's narration key");
  });

  it("contains no YouTube OAuth access or refresh token", async () => {
    const detail = await adminService.getUser(operatorId, subjectId);
    const serialized = JSON.stringify(detail);

    expect(serialized).not.toContain(OAUTH_ACCESS_TOKEN);
    expect(serialized).not.toContain(OAUTH_REFRESH_TOKEN);

    // The channel is still there, and still says whether its grant has lapsed
    // — derived from tokenExpiresAt inside the service, which does not ship.
    const channel = detail.channels.find((one) => one.id === channelId);
    expect(channel?.title).toBe("Subject's channel");
    expect(channel?.tokenExpired).toBe(false);
  });

  it("contains no activity log metadata, which holds password-reset URLs", async () => {
    // This is the non-obvious one. There is no email transport in this
    // deployment, so `recordPasswordResetRequest` writes the reset link into
    // ActivityLog.metadata and the row *is* the delivery mechanism. An admin
    // view that rendered metadata would turn "read someone's history" into
    // "take over their account".
    const resetUrl = `https://framecast.test/api/auth/reset-password/${randomUUID()}`;
    await prisma.activityLog.create({
      data: {
        userId: subjectId,
        action: "auth.passwordReset.requested",
        level: "WARN",
        message: "Password reset requested.",
        metadata: { resetUrl, delivery: "activity-log" },
      },
    });

    const detail = await adminService.getUser(operatorId, subjectId);

    expect(JSON.stringify(detail)).not.toContain(resetUrl);
    // The row itself is still listed — that a reset was requested is
    // legitimate operational history. Only the link is withheld.
    expect(detail.recentActivity.map((one) => one.action)).toContain(
      "auth.passwordReset.requested",
    );
    expect(detail.recentActivity[0]).not.toHaveProperty("metadata");
  });

  it("never reaches the Account table, where the password hash lives", async () => {
    const detail = await adminService.getUser(operatorId, subjectId);
    const serialized = JSON.stringify(detail).toLowerCase();

    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("accesstoken");
    expect(serialized).not.toContain("refreshtoken");
    expect(serialized).not.toContain("encryptedkey");
  });
});

describe("adminService.systemTotals", () => {
  it("reports the deployment's own numbers, not one account's", async () => {
    const totals = await adminService.systemTotals();

    expect(totals.userCount).toBeGreaterThanOrEqual(2);
    expect(totals.operatorCount).toBeGreaterThanOrEqual(1);
    expect(totals.videoCount).toBeGreaterThanOrEqual(1);
    expect(totals.channelCount).toBeGreaterThanOrEqual(1);
  });

  it("counts a video whose lease lapsed mid-pipeline as stalled", async () => {
    const totals = await adminService.systemTotals();

    // The fixture video is RENDERING with an hour-old lease: the worker that
    // held it died. Invisible in a plain status breakdown, which is why it
    // gets a figure of its own.
    expect(totals.stalledVideos).toBeGreaterThanOrEqual(1);
  });

  it("breaks videos down by status", async () => {
    const totals = await adminService.systemTotals();
    const rendering = totals.videosByStatus.find(
      (row) => row.status === "RENDERING",
    );

    expect(rendering?.count).toBeGreaterThanOrEqual(1);
  });

  it("writes no audit row, because no person's data was read", async () => {
    const before = await prisma.activityLog.count({
      where: { userId: operatorId },
    });

    await adminService.systemTotals();

    expect(await prisma.activityLog.count({ where: { userId: operatorId } })).toBe(
      before,
    );
  });
});
