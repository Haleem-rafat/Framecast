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
