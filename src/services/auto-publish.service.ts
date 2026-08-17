import "server-only";

import type { PublishVisibility } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { publishService, type PublishService } from "@/services/publish.service";

/**
 * The long-video drip: a video that its automation said should publish itself.
 *
 * ## What this is, and what it deliberately is not
 *
 * `ReleaseService` is the same idea for shorts, and this file copies its
 * discipline rather than inventing a second one — see `claimDue`. What is
 * different is the trigger. A release fires on a *clock*: a slot comes round and
 * whatever is banked goes out. This fires on a *state*: a video an automation
 * created reaches READY, and the job written when it was created becomes due.
 * There is no cadence here, because "publish it when it is finished" has no time
 * of day in it.
 *
 * Nothing in this file calls a model or spends provider money. The video it
 * uploads was already paid for. What it *can* spend is the operator's channel
 * reputation, which is why the switch behind it is off by default and why the
 * failure taxonomy in `executeClaim` is as careful as it is.
 */

export class AutoPublishService {
  /**
   * `Pick`, not the whole `PublishService`, for the reason `ReleaseService`
   * gives for the same choice: this service calls exactly one of its methods,
   * and typing the parameter as the full class would force every test to stub
   * the thumbnail path and the reclaims as well.
   */
  constructor(
    private readonly publisher: Pick<PublishService, "publish"> = publishService,
  ) {}

  /**
   * Books a video to publish itself once it is rendered.
   *
   * Called at *creation*, not at READY, and that is what freezes the visibility
   * — see `AutoPublishJob.visibility`. The job simply is not due until the video
   * reaches READY; `claimDue` joins on that, so nothing has to remember to
   * enqueue later and nothing can publish a half-rendered file.
   *
   * `createMany` with `skipDuplicates` rather than a pre-check: the `videoId`
   * unique constraint is the real guard, and the only way a row already exists
   * is a retried create path, where re-booking is a no-op rather than an error
   * worth surfacing. Note which one survives — the FIRST. A retry must not
   * rewrite what the video was made under.
   */
  async enqueue(
    userId: string,
    videoId: string,
    visibility: PublishVisibility,
  ): Promise<void> {
    await prisma.autoPublishJob.createMany({
      data: [{ userId, videoId, visibility }],
      skipDuplicates: true,
    });
  }
}

export const autoPublishService = new AutoPublishService();
