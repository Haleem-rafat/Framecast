import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  MIN_QUERY_LENGTH,
  RESULTS_PER_GROUP,
  SearchService,
  type SearchGroup,
  type SearchResultType,
} from "@/services/search.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

// Tests run against a real, shared Postgres database (see src/test/setup.ts)
// that also holds the operator's real data, so every test here gets its own
// throwaway User (see src/test/fixtures.ts) rather than the operator's real
// account — the same discipline script.service.test.ts documents at length.
//
// A search test has a second reason to need it. Every assertion below is of
// the form "this query returns exactly these rows", and the operator's real
// library is in the same tables: a fixture named "script" or "inflation"
// would match their content too and the assertions would be measuring the
// wrong thing. Hence RUN — a token unique to this process, embedded in every
// searchable string this file creates, so the queries under test can only
// ever find rows this file made.
const RUN = randomUUID().slice(0, 8).replace(/[0-9]/g, "z");

/** The needle. Nothing outside this file's fixtures can contain it. */
const TERM = `zx${RUN}`;

const service = new SearchService();

let userId: string;
let otherUserId: string;
let projectId: string;

/** Creates a video owned by `owner`, with `title` and an optional topic. */
async function makeVideo(
  owner: string,
  ownerProjectId: string,
  title: string,
  topic?: string,
) {
  return prisma.video.create({
    data: { userId: owner, projectId: ownerProjectId, title, topic: topic ?? null },
  });
}

/**
 * Gives `videoId` a script whose *active* version holds `content`, plus, when
 * `supersededContent` is given, an older version that is no longer active.
 */
async function makeScript(
  videoId: string,
  content: string,
  supersededContent?: string,
) {
  const script = await prisma.script.create({ data: { videoId } });

  if (supersededContent !== undefined) {
    await prisma.scriptVersion.create({
      data: { scriptId: script.id, version: 1, content: supersededContent },
    });
  }

  const active = await prisma.scriptVersion.create({
    data: {
      scriptId: script.id,
      version: supersededContent === undefined ? 1 : 2,
      content,
    },
  });

  await prisma.script.update({
    where: { id: script.id },
    data: { activeVersionId: active.id },
  });

  return active;
}

async function makeChannel(owner: string, title: string, handle?: string) {
  return prisma.channel.create({
    data: {
      userId: owner,
      youtubeChannelId: `yt-${randomUUID()}`,
      title,
      handle: handle ?? null,
      accessToken: "test-access",
      refreshToken: "test-refresh",
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: [],
    },
  });
}

function group(
  groups: SearchGroup[],
  type: SearchResultType,
): SearchGroup | undefined {
  return groups.find((entry) => entry.type === type);
}

/** Titles returned in a group, for order-insensitive assertions. */
function titles(groups: SearchGroup[], type: SearchResultType): string[] {
  return (group(groups, type)?.results ?? []).map((result) => result.title);
}

beforeEach(async () => {
  userId = await createTestUser("search");
  otherUserId = await createTestUser("search-other");
  projectId = (
    await prisma.project.create({ data: { userId, name: `Project ${TERM}` } })
  ).id;
});

afterEach(async () => {
  // Everything this file creates hangs off one of the two users, so the
  // cascade in deleteTestUser removes all of it — no marker-scoped sweep
  // needed the way script.service.test.ts needs one for ProviderUsage.
  await deleteTestUser(userId);
  await deleteTestUser(otherUserId);
});

describe("searchService.search — query length", () => {
  it("does not query the database below the minimum length", async () => {
    const response = await service.search(userId, TERM.slice(0, MIN_QUERY_LENGTH - 1));

    expect(response.tooShort).toBe(true);
    expect(response.groups).toEqual([]);
  });

  it("treats a whitespace-only query as too short", async () => {
    const response = await service.search(userId, "     ");

    expect(response.tooShort).toBe(true);
  });

  it("runs once the query reaches the minimum length", async () => {
    const response = await service.search(userId, TERM);

    expect(response.tooShort).toBe(false);
    expect(response.query).toBe(TERM);
  });
});

describe("searchService.search — what matches", () => {
  it("finds a video by title and by topic, and reports its status", async () => {
    await makeVideo(userId, projectId, `Video about ${TERM}`);
    await makeVideo(userId, projectId, "Unrelated title", `topic ${TERM}`);

    const { groups } = await service.search(userId, TERM);

    expect(titles(groups, "video").sort()).toEqual([
      "Unrelated title",
      `Video about ${TERM}`,
    ]);
    // The palette renders this as the row's badge, so it has to survive the
    // mapping rather than being dropped with the rest of the record.
    expect(group(groups, "video")?.results[0].status).toBe("DRAFT");
  });

  it("matches case-insensitively", async () => {
    await makeVideo(userId, projectId, `Video about ${TERM.toUpperCase()}`);

    const { groups } = await service.search(userId, TERM.toLowerCase());

    expect(titles(groups, "video")).toHaveLength(1);
  });

  it("matches a substring in the middle of a word", async () => {
    // The whole reason this is ILIKE rather than full-text search: an
    // operator half-way through typing a title must still see it.
    await makeVideo(userId, projectId, `The ${TERM}mechanism explained`);

    const { groups } = await service.search(userId, TERM.slice(0, 4));

    expect(titles(groups, "video")).toHaveLength(1);
  });

  it("finds a project by name", async () => {
    const { groups } = await service.search(userId, TERM);

    expect(titles(groups, "project")).toEqual([`Project ${TERM}`]);
  });

  it("finds a channel by title and by handle", async () => {
    await makeChannel(userId, `Channel ${TERM}`);
    await makeChannel(userId, "Plain channel", `@${TERM}`);

    const { groups } = await service.search(userId, TERM);

    expect(titles(groups, "channel").sort()).toEqual([
      `Channel ${TERM}`,
      "Plain channel",
    ]);
  });

  it("finds a prompt template by name and by description", async () => {
    await prisma.promptTemplate.create({
      data: { userId, name: `Template ${TERM}`, category: "SCRIPT", content: "x" },
    });
    await prisma.promptTemplate.create({
      data: {
        userId,
        name: "Plain template",
        description: `Describes ${TERM}`,
        category: "SCRIPT",
        content: "x",
      },
    });

    const { groups } = await service.search(userId, TERM);

    expect(titles(groups, "prompt").sort()).toEqual([
      "Plain template",
      `Template ${TERM}`,
    ]);
  });

  it("finds a prompt template by its category name", async () => {
    // `category` is a Postgres enum, so `contains` cannot reach it — the
    // service resolves the term to enum members instead. This asserts that
    // path, not just that the OR compiles.
    await prisma.promptTemplate.create({
      data: {
        userId,
        name: `Thumbnails ${TERM}`,
        category: "THUMBNAIL",
        content: "x",
      },
    });

    const { groups } = await service.search(userId, "thumbnail");

    expect(titles(groups, "prompt")).toContain(`Thumbnails ${TERM}`);
  });

  it("finds a video by the text of its script and returns a snippet, not the whole script", async () => {
    const video = await makeVideo(userId, projectId, "A video with no matching title");
    const long = `${"padding word ".repeat(200)}the ${TERM} appears here${" trailing word".repeat(200)}`;
    await makeScript(video.id, long);

    const { groups } = await service.search(userId, TERM);

    const result = group(groups, "script")?.results[0];
    expect(result?.title).toBe("A video with no matching title");
    expect(result?.href).toBe(`/videos/${video.id}`);
    expect(result?.subtitle).toContain(TERM);
    // A two-thousand-word narration must not be shipped to the palette to
    // render one row of it.
    expect(result?.subtitle?.length ?? 0).toBeLessThan(200);
    expect(result?.subtitle?.startsWith("…")).toBe(true);
  });

  it("searches only the active script version, not superseded ones", async () => {
    // A regenerated video has several near-identical versions. Matching all of
    // them would list the same video repeatedly for text it no longer shows.
    const video = await makeVideo(userId, projectId, "Regenerated video");
    await makeScript(video.id, "The current narration.", `An older draft about ${TERM}.`);

    const { groups } = await service.search(userId, TERM);

    expect(group(groups, "script")).toBeUndefined();
  });

  it("omits groups that matched nothing", async () => {
    await makeVideo(userId, projectId, `Video about ${TERM}`);

    const { groups } = await service.search(userId, TERM);

    expect(group(groups, "channel")).toBeUndefined();
    expect(group(groups, "prompt")).toBeUndefined();
  });

  it("returns no groups at all when nothing matches", async () => {
    const { groups, tooShort } = await service.search(userId, `nothing${RUN}here`);

    expect(tooShort).toBe(false);
    expect(groups).toEqual([]);
  });
});

describe("searchService.search — result caps", () => {
  it("caps a group and flags it as truncated", async () => {
    for (let index = 0; index < RESULTS_PER_GROUP + 3; index++) {
      await makeVideo(userId, projectId, `Video ${index} about ${TERM}`);
    }

    const { groups } = await service.search(userId, TERM);
    const videos = group(groups, "video");

    expect(videos?.results).toHaveLength(RESULTS_PER_GROUP);
    // The UI reads this to say "showing the first five" rather than silently
    // presenting five of eight as if that were the whole answer.
    expect(videos?.truncated).toBe(true);
  });

  it("does not flag truncation when the group fits exactly", async () => {
    for (let index = 0; index < RESULTS_PER_GROUP; index++) {
      await makeVideo(userId, projectId, `Video ${index} about ${TERM}`);
    }

    const videos = group((await service.search(userId, TERM)).groups, "video");

    expect(videos?.results).toHaveLength(RESULTS_PER_GROUP);
    expect(videos?.truncated).toBe(false);
  });
});

describe("searchService.search — soft deletes", () => {
  it("ignores soft-deleted videos, projects, channels and templates", async () => {
    const video = await makeVideo(userId, projectId, `Deleted video ${TERM}`);
    await prisma.video.update({
      where: { id: video.id },
      data: { deletedAt: new Date() },
    });
    await prisma.project.update({
      where: { id: projectId },
      data: { deletedAt: new Date() },
    });
    const channel = await makeChannel(userId, `Deleted channel ${TERM}`);
    await prisma.channel.update({
      where: { id: channel.id },
      data: { deletedAt: new Date() },
    });
    const template = await prisma.promptTemplate.create({
      data: { userId, name: `Deleted template ${TERM}`, category: "SCRIPT", content: "x" },
    });
    await prisma.promptTemplate.update({
      where: { id: template.id },
      data: { deletedAt: new Date() },
    });

    const { groups } = await service.search(userId, TERM);

    expect(groups).toEqual([]);
  });

  it("ignores the script of a soft-deleted video", async () => {
    // Script carries no deletedAt of its own — it is only excluded because the
    // scoping walks back to the video, which is the same walk that enforces
    // ownership. A regression in one is a regression in the other.
    const video = await makeVideo(userId, projectId, "Doomed video");
    await makeScript(video.id, `Narration mentioning ${TERM}.`);
    await prisma.video.update({
      where: { id: video.id },
      data: { deletedAt: new Date() },
    });

    const { groups } = await service.search(userId, TERM);

    expect(group(groups, "script")).toBeUndefined();
  });
});

describe("searchService.search — LIKE wildcards in the operator's own text", () => {
  it("treats a percent sign as a literal, not as 'match everything'", async () => {
    await makeVideo(userId, projectId, `Video about ${TERM}`);
    await makeVideo(userId, projectId, `Discount 50% off ${TERM}`);

    // Unescaped, `%` would compile to `ILIKE '%%%'` and return the operator's
    // entire library — a search box that answers "everything" to a keystroke.
    const { groups } = await service.search(userId, "%");

    expect(groups).toEqual([]);

    const literal = await service.search(userId, "50%");
    expect(titles(literal.groups, "video")).toEqual([`Discount 50% off ${TERM}`]);
  });

  it("treats an underscore as a literal, not as a single-character wildcard", async () => {
    await makeVideo(userId, projectId, `Video about ${TERM}`);
    await makeVideo(userId, projectId, `File_name ${TERM}`);

    const { groups } = await service.search(userId, "e_n");

    expect(titles(groups, "video")).toEqual([`File_name ${TERM}`]);
  });
});

// ---------------------------------------------------------------------------
// The failure that matters most. A search that returns another operator's
// titles does not throw, does not log and does not look broken — it looks like
// a working search. Every model this service touches gets its own assertion,
// including the two reached only through a relation.
// ---------------------------------------------------------------------------
describe("searchService.search — cross-user isolation", () => {
  it("never returns another operator's videos", async () => {
    const otherProject = await prisma.project.create({
      data: { userId: otherUserId, name: "Other project" },
    });
    await makeVideo(otherUserId, otherProject.id, `Their video about ${TERM}`);
    await makeVideo(userId, projectId, `My video about ${TERM}`);

    const { groups } = await service.search(userId, TERM);

    expect(titles(groups, "video")).toEqual([`My video about ${TERM}`]);
  });

  it("never returns another operator's script text", async () => {
    // ScriptVersion has no userId column at all; it is scoped only by
    // script.video.userId. Drop that clause and this test is the one that
    // catches it.
    const otherProject = await prisma.project.create({
      data: { userId: otherUserId, name: "Other project" },
    });
    const theirVideo = await makeVideo(otherUserId, otherProject.id, "Their video");
    await makeScript(theirVideo.id, `Their narration about ${TERM}.`);

    const { groups } = await service.search(userId, TERM);

    expect(group(groups, "script")).toBeUndefined();
  });

  it("never returns another operator's projects", async () => {
    await prisma.project.create({
      data: { userId: otherUserId, name: `Their project ${TERM}` },
    });

    const { groups } = await service.search(userId, TERM);

    expect(titles(groups, "project")).toEqual([`Project ${TERM}`]);
  });

  it("never returns another operator's channels", async () => {
    await makeChannel(otherUserId, `Their channel ${TERM}`, `@${TERM}`);

    const { groups } = await service.search(userId, TERM);

    expect(group(groups, "channel")).toBeUndefined();
  });

  it("never returns another operator's prompt templates", async () => {
    await prisma.promptTemplate.create({
      data: {
        userId: otherUserId,
        name: `Their template ${TERM}`,
        description: `About ${TERM}`,
        category: "SCRIPT",
        content: "x",
      },
    });

    const { groups } = await service.search(userId, TERM);

    expect(group(groups, "prompt")).toBeUndefined();
  });

  it("returns nothing at all for an operator who owns none of the matching content", async () => {
    // The blunt version of every assertion above: the same query that finds
    // eight things for its owner must find zero for anyone else.
    const video = await makeVideo(userId, projectId, `My video about ${TERM}`);
    await makeScript(video.id, `My narration about ${TERM}.`);
    await makeChannel(userId, `My channel ${TERM}`);
    await prisma.promptTemplate.create({
      data: { userId, name: `My template ${TERM}`, category: "SCRIPT", content: "x" },
    });

    expect((await service.search(userId, TERM)).groups.length).toBeGreaterThan(0);
    expect((await service.search(otherUserId, TERM)).groups).toEqual([]);
  });
});
