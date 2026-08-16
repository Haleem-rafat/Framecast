import { z } from "zod";

export const createProjectSchema = z.object({
  name: z.string().min(1, "Name is required").max(80),
  description: z.string().max(500).optional(),
  channelId: z.string().uuid().optional(),
  /**
   * Acknowledgement that changing `channelId` also moves every series filed
   * under this project onto the new channel.
   *
   * This field exists because that used to happen silently. A series stores its
   * own `channelId` — every screen an operator sees reads *that* copy, while
   * `PublishService` uploads to `project.channelId` — so moving a project used
   * to leave a show saying "kids channel" on screen while its episodes uploaded
   * to a finance channel. Nothing warned anybody, and the divergence is
   * invisible until an irreversible upload lands on the wrong channel.
   *
   * `false`/absent is the safe direction, and deliberately so: a request that
   * has never heard of this field (an older client, a hand-made call) is
   * refused by `ProjectService.update` rather than allowed through to redirect
   * shows nobody mentioned. Only a caller that has been told how many series
   * are attached — the edit dialog states the number and names them — can send
   * `true`.
   *
   * It carries no meaning at all for a project with no series attached, and no
   * meaning on create: a project seconds old has nothing filed under it.
   */
  moveAttachedSeries: z.boolean().optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

/**
 * Fold several projects into one. See `ProjectService.merge`.
 *
 * `sourceIds` may contain `targetId` — "merge these four rows" is how the
 * operator thinks about it when the survivor is one of the four, and the
 * service drops it rather than refusing. It may not be empty, though: an empty
 * merge is a request that means nothing, and refusing it here is cheaper than
 * a round trip that reports having moved nothing.
 *
 * The cap is a sanity bound, not a product rule. The measured worst case is 16
 * `job-<uuid>` projects on a production account; 50 leaves room for that to
 * grow and still refuses a request that could only be a mistake or an attack.
 *
 * `name` is optional and renames the surviving project in the same
 * transaction. It exists because the target is chosen for its *channel* — the
 * one property a merge cannot change — and that can easily be a project called
 * `job-4f2c…`, whose name should not survive a merge with anything a person
 * named. Absent or blank leaves the target's name alone.
 */
export const mergeProjectsSchema = z.object({
  targetId: z.string().uuid(),
  sourceIds: z.array(z.string().uuid()).min(1).max(50),
  name: z.string().max(80).optional(),
});

export type MergeProjectsInput = z.infer<typeof mergeProjectsSchema>;
