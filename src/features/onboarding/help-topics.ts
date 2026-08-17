/**
 * One short note per screen, shown the first time somebody lands there.
 *
 * ## Why this exists instead of more tour steps
 *
 * The studio has twenty-odd screens. A tour that visited them all would be a
 * thirty-step forced march through features the operator has no use for yet,
 * and it would be read once, badly, on the day they were least able to absorb
 * it. Splitting it up moves each explanation to the moment it is useful: the
 * first time you open /automation you are told what a series is and how it
 * differs from a topic queue, because you are standing on the screen that makes
 * them, and never again after that.
 *
 * The tour keeps one job — get this person to their first video — and step four
 * of it tells them these exist. See tour-steps.ts.
 *
 * ## The rule every entry follows
 *
 * Describe what is on the screen today, and prefer the thing that is not
 * obvious from reading the labels. The tour these replaced had drifted into
 * describing an app that no longer existed, which is worse than saying nothing:
 * an operator who is told to look for a control that is not there concludes the
 * fault is theirs.
 */

export interface HelpTopic {
  /** Stable id. Also the stored dismissal key, via `helpKey`. */
  id: string;
  /**
   * The route this belongs to, with `:param` standing for a dynamic segment.
   * Matched as a *prefix* of the path (see `resolveHelpTopic`), so
   * `/channels/:id` also covers anything nested under a channel.
   */
  pattern: string;
  title: string;
  body: string;
  /** An optional way onward, when there is an obvious next screen. */
  action?: { label: string; href: string };
  /**
   * Hidden from a member, mirroring `operatorOnly` in config/navigation.ts.
   *
   * Belt and braces rather than protection: both screens carry
   * `requireOperator()` and redirect a member before they render, so a member
   * cannot reach a path these match. It costs one boolean to make that true in
   * two places instead of one.
   */
  operatorOnly?: boolean;
}

export const HELP_TOPICS: HelpTopic[] = [
  // ---------------------------------------------------------------- automation
  {
    id: "automation",
    pattern: "/automation",
    title: "Three kinds of automation, one list",
    body:
      "A series is a named show — its own script style, format and cadence, " +
      "everything else inherited from a channel. A topic queue is the same " +
      "without the show: subjects and a clock, written with your default " +
      "style. A shorts drip is the odd one out — it makes nothing, it " +
      "publishes clips already cut from videos you finished, a few a day. " +
      "That makes it the only thing in Framecast that puts anything on " +
      "YouTube without you pressing something.",
    action: { label: "Make one video now", href: "/automation/generate" },
  },
  {
    id: "generate",
    pattern: "/automation/generate",
    title: "Easy mode asks two questions",
    body:
      "Which channel, and what about. Everything else — the script style, the " +
      "length, the project it is filed in — is worked out from the channel " +
      "and your defaults, and “What Framecast decided” lists every answer " +
      "with where it came from. Subjects you wrote are offered first, then " +
      "ones written for the channel's niche, then ideas that ship with " +
      "Framecast. It approves the script for you and starts the render; " +
      "publishing is still a separate, deliberate click.",
  },
  {
    id: "series-new",
    pattern: "/automation/series/new",
    title: "Answer this once; every episode inherits it",
    body:
      "A series is a name, a channel, a project, a script style, a format and " +
      "a cadence. Niche, tone, voice, music, footage style, art style, the " +
      "recurring character, language, category and the made-for-kids " +
      "declaration are not asked here — they come from the channel, so " +
      "changing the channel changes every future episode at once. Episodes " +
      "come from the topic queue at the bottom. Nothing invents a subject.",
  },
  {
    id: "series-detail",
    pattern: "/automation/series/:id",
    title: "What this show decides, and what it inherits",
    body:
      "The recipe card keeps the two apart: above are the choices this series " +
      "makes, below are the channel's, which move when you edit the channel. " +
      "The topic queue is what it will make next, oldest first — when it runs " +
      "out the series stops rather than guessing. “Make one now” produces an " +
      "episode immediately without disturbing the cadence.",
  },
  {
    id: "schedule-new",
    pattern: "/automation/schedules/new",
    title: "A list and a clock",
    body:
      "The simplest automation there is: subjects on one side, a cadence on " +
      "the other, each video written with your default script style. Choose a " +
      "series instead if these videos are one show with a look of their own.",
  },
  {
    id: "schedule-detail",
    pattern: "/automation/schedules/:id",
    title: "An empty queue means skipped, not broken",
    body:
      "One subject is consumed per run, oldest first. A run that comes due " +
      "with nothing waiting is recorded as skipped rather than inventing a " +
      "topic, and the run history is where the two are told apart. Pausing " +
      "stops it entirely until you resume it.",
  },
  {
    id: "release-new",
    pattern: "/automation/releases/new",
    title: "A drip spends; it does not make",
    body:
      "A shorts drip publishes shorts that were already cut from your " +
      "finished videos, a few a day at times you set — so it has nothing to " +
      "spend until a video has rendered and been clipped. One cadence per " +
      "channel: two would race each other for the same queue of clips.",
  },
  {
    id: "release-detail",
    pattern: "/automation/releases/:id",
    title: "Nothing banked is not a fault",
    body:
      "A slot with no clip waiting is recorded as skipped, and the drip picks " +
      "up by itself the moment another video is cut into shorts. There is " +
      "nothing to resume and nothing to fix.",
  },

  // ------------------------------------------------------------------ channels
  {
    id: "channels",
    pattern: "/channels",
    title: "The channel holds most of the decisions",
    body:
      "Connecting one asks YouTube for upload and read-only access, nothing " +
      "more. It is where finished videos publish to and where the analytics " +
      "are read back from — and, less obviously, where nearly every creative " +
      "choice is stored. Open Branding on a channel to set them.",
  },
  {
    id: "channel-brand",
    pattern: "/channels/:id",
    title: "Every video from this channel inherits this page",
    body:
      "Niche and tone steer the thumbnail, the logo, which moments become " +
      "shorts, and the title, description and tags — but not the script, " +
      "which comes from your prompt. The voice applies to narration from here " +
      "on. Footage chooses live action, cartoon or illustrated story; " +
      "illustrated adds an art style and a character sheet, which is what " +
      "keeps the same character in scene one and scene forty. Language, " +
      "category and the made-for-kids answer are sent to YouTube on every " +
      "upload from this channel.",
  },

  // -------------------------------------------------------------------- videos
  {
    id: "videos",
    pattern: "/videos",
    title: "Every video, however it was made",
    body:
      "Anything One-click video or an automation produced arrives here " +
      "already written and queued. Creating one from this page is the manual " +
      "route instead: it starts as a draft and waits for you to generate a " +
      "script and approve it. Open a row to watch the pipeline, read the " +
      "script, scrub the timeline or publish.",
    action: { label: "Or make one in a click", href: "/automation/generate" },
  },
  {
    id: "video-detail",
    pattern: "/videos/:id",
    title: "One video, in sections that fold",
    body:
      "Which sections start open depends on where the video is: the script " +
      "while it is a draft, the pipeline while it runs, the preview and " +
      "timeline once it is finished. Timeline is where a section's footage " +
      "gets replaced; Shorts cuts clips out of a finished render. Publish " +
      "lives in the header and is the only control here that touches YouTube. " +
      "Whether you left a section open is remembered in this browser.",
  },

  // ------------------------------------------------------------------ projects
  {
    id: "projects",
    pattern: "/projects",
    title: "A project decides where a video may go",
    body:
      "Every video belongs to one, and the project's channel is what makes it " +
      "publishable — easy mode will not offer a channel that no project " +
      "points at. Framecast also notices projects that look like duplicates " +
      "and offers to merge them, which moves the videos across rather than " +
      "deleting anything.",
  },

  // ---------------------------------------------------------------- publishing
  {
    id: "publishing",
    pattern: "/publishing",
    title: "A record, not a control panel",
    body:
      "What has gone to YouTube, what is scheduled, what failed, and what is " +
      "rendered and waiting. Publishing itself happens on a video's own page, " +
      "where the button asks which channel and who can watch. A failed row is " +
      "kept on purpose: it is what stops a second upload firing at a video " +
      "that may already be live, so clearing it is a deliberate step.",
  },

  // ----------------------------------------------------------------- analytics
  {
    id: "analytics",
    pattern: "/analytics",
    title: "Two different kinds of number",
    body:
      "The top of the page is YouTube's — subscribers, views, watch time and, " +
      "where the channel earns, estimated revenue — collected on a schedule " +
      "and stamped with when. Below that is what this deployment did: render " +
      "success, how long renders take, what the providers cost. Impressions " +
      "and click-through are absent because the Analytics API refuses them " +
      "for a channel query, and changes are counted from the first collection " +
      "onward, because YouTube keeps no history to backfill from.",
  },

  // ------------------------------------------------------------- configuration
  {
    id: "prompts",
    pattern: "/prompts",
    title: "The prompt is how your videos sound",
    body:
      "The SCRIPT template marked as default writes every script, unless a " +
      "series names a different one. Browse the styles that ship with " +
      "Framecast if you would rather start from one of those than from a " +
      "blank template. The thumbnail, scene and metadata categories control " +
      "the rest of the generated text and imagery.",
  },
  {
    id: "providers",
    pattern: "/providers",
    title: "Your keys, encrypted, per account",
    body:
      "ElevenLabs is the one a run cannot finish without: narration is the " +
      "first paid stage after the script, so a missing key costs you a script " +
      "you have already paid for. The second table is platform services set " +
      "by the deployment's environment and is read-only here. Spend is " +
      "recorded deployment-wide rather than per account.",
  },
  {
    id: "settings",
    pattern: "/settings",
    title: "Defaults, and where the guides live",
    body:
      "Theme and accent are stored against your account, so they follow you " +
      "to another browser. Several values here are saved but not yet read by " +
      "the pipeline — each field says where its value actually comes from " +
      "today, rather than letting you assume. The Guides card replays the " +
      "welcome tour and brings back these screen notes.",
  },

  // -------------------------------------------------------------------- studio
  {
    id: "studio-script",
    pattern: "/studio/script",
    title: "Every script, in one place",
    body:
      "Anything written for one of your videos collects here — generated, " +
      "imported or hand-edited. Writing a new one and approving it happens on " +
      "the video's own page, not from this list.",
  },
  {
    id: "studio-voice",
    pattern: "/studio/voice",
    title: "Narration is made by the pipeline",
    body:
      "A take appears here once a script has been approved and the run " +
      "reaches narration; there is nothing to press. Which voice speaks is a " +
      "channel setting. To redo one in a different voice, open the video and " +
      "use Re-narrate.",
  },
  {
    id: "studio-thumbnail",
    pattern: "/studio/thumbnail",
    title: "Thumbnails make themselves",
    body:
      "One is generated when a video finishes rendering, using that channel's " +
      "colours, headline font and logo. Every attempt is kept, so this is " +
      "where you compare them rather than where you request them.",
  },

  // ------------------------------------------------------------------ activity
  {
    id: "logs",
    pattern: "/logs",
    title: "Where to look when something went wrong",
    body:
      "Generating a script, narrating, publishing — each writes a line here, " +
      "newest first, and this is the first place to check when a video failed " +
      "and its own page does not say enough. The action list stays complete " +
      "while you narrow by level, so filtering never hides the filter you " +
      "wanted next.",
  },

  // ------------------------------------------------------------ operator only
  {
    id: "approvals",
    pattern: "/approvals",
    title: "Nobody gets in until you say so",
    body:
      "Registration is open, and every render spends your API credits — so a " +
      "new account can sign in, see that it is waiting, and do nothing else. " +
      "Approving lets somebody use the studio; it does not let them decide on " +
      "anybody else. That is a separate role, granted by hand.",
    operatorOnly: true,
  },
  {
    id: "admin",
    pattern: "/admin",
    title: "Read-only, and it is audited",
    body:
      "Every account in this deployment and the state of the machine they " +
      "share. Opening it writes a line to the activity log, because every " +
      "name and address in the table belongs to somebody. The only decision " +
      "an operator makes about an account is taken at Approvals.",
    operatorOnly: true,
  },
];

/**
 * How specific a pattern's claim on a path is, or null when it has none.
 *
 * Prefix rather than exact match, so a route nested under a screen inherits
 * that screen's note instead of falling through to nothing —
 * `/studio/thumbnail/image/:versionId` is still the thumbnail screen.
 *
 * Two numbers rather than one because prefix matching alone cannot separate
 * `/automation/series/new` from `/automation/series/:id`: both are three
 * segments and both match. Literal segments win that tie, which is the same
 * rule Next.js' own router uses to decide that `new` is a page and not an id.
 */
function score(pattern: string, pathname: string): [number, number] | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);

  if (patternParts.length > pathParts.length) return null;

  let literals = 0;

  for (const [index, part] of patternParts.entries()) {
    if (part.startsWith(":")) continue;
    if (part !== pathParts[index]) return null;
    literals += 1;
  }

  return [patternParts.length, literals];
}

/**
 * The one note that belongs to this path, or null where there is nothing worth
 * saying — /dashboard being the deliberate example: the tour and the setup
 * checklist already own that screen, and a third thing explaining it would be
 * the fourth panel a new operator has to dismiss before seeing their own data.
 */
export function resolveHelpTopic(
  pathname: string,
  isOperator: boolean,
): HelpTopic | null {
  let best: HelpTopic | null = null;
  let bestScore: [number, number] = [-1, -1];

  for (const topic of HELP_TOPICS) {
    if (topic.operatorOnly && !isOperator) continue;

    const candidate = score(topic.pattern, pathname);
    if (!candidate) continue;

    if (
      candidate[0] > bestScore[0] ||
      (candidate[0] === bestScore[0] && candidate[1] > bestScore[1])
    ) {
      best = topic;
      bestScore = candidate;
    }
  }

  return best;
}
