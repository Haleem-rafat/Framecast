import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

/**
 * Changes the visibility of a video this studio already published.
 *
 *   pnpm tsx --conditions=react-server scripts/set-visibility.ts <videoId> private
 *   pnpm tsx --conditions=react-server scripts/set-visibility.ts <videoId> unlisted
 *   pnpm tsx --conditions=react-server scripts/set-visibility.ts <videoId> public
 *
 * `videoId` is this app's `Video.id`, not YouTube's — the YouTube id is read
 * from the `Publication` row, so a video that was never published cannot be
 * addressed here at all.
 *
 * ## Why this exists
 *
 * Publishing is deliberately one-shot: `PublishService` takes a claim on
 * `Publication` before a byte is sent and there is no second path through it.
 * That is the right shape for uploading — it is what stops a retry putting the
 * same video on a channel twice — but it left no way back. A video that went
 * out at the wrong visibility (an automation with `autoPublish` armed picking up
 * a video somebody was only testing with, which is exactly how this script came
 * to be written) could only be fixed by hand in YouTube Studio.
 *
 * ## Why it writes to the Publication row too
 *
 * `Publication.visibility` records what YouTube was told, and the whole reason
 * that column is stored rather than derived is so it keeps saying what actually
 * happened. Changing the video on YouTube and leaving the row saying PUBLIC
 * would make this app's account of its own channel wrong — which is worse than
 * having no script at all, because the studio would then be confidently
 * mistaken. Both move, or neither does: YouTube first, because it is the half
 * that can fail.
 *
 * This does NOT delete anything. Visibility is reversible in both directions and
 * every value it accepts is one YouTube itself accepts.
 *
 * ## It needs a scope this app does not currently ask for
 *
 * `youtube-oauth.ts` requests `youtube.upload` and `youtube.readonly`. Neither
 * permits `videos.update`, which needs the full `youtube` scope — so against a
 * channel connected by this app today, this script stops before it sends
 * anything and says so. Publishing is therefore one-way in practice: the studio
 * can put a video on a channel and cannot change it afterwards.
 *
 * That is worth knowing rather than working around. Widening the scope widens
 * what a stolen token can do to somebody's channel — from "upload a video" to
 * "edit or hide anything on it" — and that is a decision to make deliberately,
 * not one to slip in so a script can run. Until it is made, YouTube Studio is
 * the way, and this file's job is to say so in one line instead of letting the
 * next person rediscover it through a 403.
 */

/** Either of these permits `videos.update`. `youtube.upload` does not. */
const WRITE_SCOPES = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
];

const ALLOWED = ["private", "unlisted", "public"] as const;

type Visibility = (typeof ALLOWED)[number];

/** `PublishVisibility` in the schema is upper case; YouTube's API is lower. */
function toColumn(visibility: Visibility): "PRIVATE" | "UNLISTED" | "PUBLIC" {
  return visibility.toUpperCase() as "PRIVATE" | "UNLISTED" | "PUBLIC";
}

async function main(): Promise<void> {
  const [videoId, requested] = process.argv.slice(2);

  if (!videoId || !ALLOWED.includes(requested as Visibility)) {
    console.error(`usage: set-visibility.ts <videoId> <${ALLOWED.join("|")}>`);
    process.exit(1);
  }

  const visibility = requested as Visibility;

  const { prisma } = await import("@/lib/prisma");
  const { channelService } = await import("@/services/channel.service");

  const publication = await prisma.publication.findFirstOrThrow({
    where: { videoId, youtubeVideoId: { not: null } },
    select: {
      id: true,
      youtubeVideoId: true,
      title: true,
      visibility: true,
      channelId: true,
      video: { select: { userId: true, title: true } },
      channel: { select: { title: true } },
    },
  });

  console.log(`video    ${publication.video.title}`);
  console.log(`channel  ${publication.channel.title}`);
  console.log(`youtube  ${publication.youtubeVideoId}`);
  console.log(`change   ${publication.visibility} → ${toColumn(visibility)}\n`);

  if (publication.visibility === toColumn(visibility)) {
    console.log("already at that visibility; nothing sent.");
    await prisma.$disconnect();
    return;
  }

  // Checked against what was actually granted, before a token is fetched and
  // before a request is sent. The API's answer for a missing scope is a 403
  // reading "Request had insufficient authentication scopes", which names
  // neither the scope nor the fix.
  const channel = await prisma.channel.findUniqueOrThrow({
    where: { id: publication.channelId },
    select: { scopes: true },
  });

  if (!channel.scopes.some((scope) => WRITE_SCOPES.includes(scope))) {
    console.error(
      "This channel was connected with upload-only permission, which cannot " +
        "change a video after the fact.\n\n" +
        `Change it here instead:\n  https://studio.youtube.com/video/${publication.youtubeVideoId}/edit\n\n` +
        "To do it from here, this app would have to request the full `youtube` " +
        "scope at connect time and every channel would have to be reconnected — " +
        "see this file's header for why that is not a change to make casually.",
    );
    await prisma.$disconnect();
    process.exit(1);
  }

  const accessToken = await channelService.resolveAccessToken(
    publication.video.userId,
    publication.channelId,
  );

  // `part=status` and a status block carrying only `privacyStatus`. The Data
  // API treats an update as a REPLACE of the parts named, so sending a wider
  // part here would blank every field of it this call did not repeat — which is
  // how a title and description get silently destroyed by a visibility change.
  const response = await fetch(
    "https://www.googleapis.com/youtube/v3/videos?part=status",
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: publication.youtubeVideoId,
        status: { privacyStatus: visibility },
      }),
    },
  );

  if (!response.ok) {
    console.error(`YouTube refused (${response.status}): ${(await response.text()).slice(0, 400)}`);
    console.error("\nNothing was changed here either — the row still says what YouTube says.");
    await prisma.$disconnect();
    process.exit(1);
  }

  await prisma.publication.update({
    where: { id: publication.id },
    data: { visibility: toColumn(visibility) },
  });

  console.log(`done — now ${visibility} on YouTube, and the Publication row says so.`);
  await prisma.$disconnect();
}

void main();
