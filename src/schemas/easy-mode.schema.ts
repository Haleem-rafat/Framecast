import { z } from "zod";

/**
 * Everything easy mode's one button submits — and, far more importantly,
 * everything it *cannot*.
 *
 * There is no `projectId` here, no `variables`, no duration and no script
 * style. Not because the UI happens not to send them, but because a server
 * action is a public endpoint and this schema is the boundary: the project a
 * video is filed under decides which YouTube channel it can ever be published
 * to (`PublishService.resolvePublishTarget`), so easy mode derives it
 * server-side from the chosen channel on every call and there is deliberately
 * no door through which a request could name a different one. The same
 * argument covers the prompt answers — those come from the channel's brand and
 * the operator's own schedules, both read on the server, both unreachable from
 * here.
 *
 * `topic`'s bounds are copied from `startAutomationSchema` rather than
 * loosened, so a subject accepted here is one the written form would also have
 * accepted. That matters because both paths end in the same
 * `AutomationService.start`: two entry points must not disagree about what a
 * valid topic is.
 *
 * `topic` is a plain string rather than an id into the suggestion list on
 * purpose. A suggestion is a *proposal* — the operator taps one and its text
 * becomes the video's subject, exactly as if they had typed it — and modelling
 * it as an id would mean this endpoint could address `ScheduleTopic` rows,
 * which belong to a schedule's queue and must never be consumed, edited or even
 * named by this flow.
 */
export const startEasyVideoSchema = z.object({
  channelId: z.string().uuid(),
  topic: z.string().min(3, "Give the subject a few more words").max(300),
});

export type StartEasyVideoInput = z.infer<typeof startEasyVideoSchema>;

/** The suggestion button's payload. A channel, and nothing else — the niche,
 *  tone and script style the model is told about are all read server-side from
 *  that channel, so no request can steer what the model is asked for. */
export const suggestSubjectsSchema = z.object({
  channelId: z.string().uuid(),
});

export type SuggestSubjectsInput = z.infer<typeof suggestSubjectsSchema>;
