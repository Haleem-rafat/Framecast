/**
 * What to tell an operator when the AI Gateway refuses, and whether anything
 * is worth retrying.
 *
 * Pure, and separate from `gateway.provider.ts`, for the reason
 * `oauth-refresh.ts` gives about Google: the thing worth getting right is a
 * decision about a provider's response body, and a decision about a response
 * body should be testable against real response bodies rather than against a
 * mocked SDK.
 *
 * ## Why this exists
 *
 * Every failure of a gateway call reported the same sentence — "The model
 * provider failed to generate a script." — whatever had actually happened. On
 * 25 August 2026 this deployment's gateway hit its spend limit, and for the
 * next two days every scheduled run across five schedules failed on a 402 while
 * saying that. The one fact that would have fixed it in a minute (top up the
 * budget) never reached anybody, and the schedules kept firing on time into a
 * wall.
 *
 * ## Classify on the code, never the prose — and never the name
 *
 * `oauth-refresh.ts` learned this against `error_description`; the gateway
 * teaches it again, more sharply. The SDK reports a spend limit as
 *
 *     GatewayInternalServerError: Team budget exceeded … | status 402
 *
 * The **name says InternalServerError and the status says 402**. Anything that
 * classifies on the name reads a permanent, operator-actionable refusal as a
 * transient server fault and retries it forever, on every schedule, for free —
 * which is exactly the behaviour that made this invisible. So the decision here
 * reads the status and the machine-readable `type` in the body, and nothing
 * else.
 *
 * ## Why a spend limit is not "just another failure"
 *
 * `ScheduleService` pauses a schedule after `MAX_CONSECUTIVE_FAILURES` runs in
 * a row fail, on the reasoning that one bad Monday is bad luck and three is a
 * broken schedule. That reasoning does not hold here, and this deployment
 * proved it: the counter is **per schedule** and the budget is **per account**,
 * so five schedules each failing once looked like five separate bad days and
 * not one wall that every single one of them had hit. Nothing paused. A caller
 * that can see `budgetExhausted` can stop on the first one instead.
 */

import { causeChain } from "@/lib/structured-output";

/** The gateway's shape for a refusal. Every field optional: a 502 from the
 *  front door is an HTML page, not this. */
interface GatewayErrorBody {
  error?: { message?: string; type?: string };
}

/**
 * The gateway's machine-readable code for "this account may not spend more".
 *
 * Exported so the test asserts the constant is *applied* rather than restating
 * the string — a copy in the test would pass forever after somebody edited only
 * the copy.
 */
export const BUDGET_EXCEEDED_TYPE = "quota_for_entity_exceeded";

/** HTTP 402. The status a spend limit arrives with, whatever the error is
 *  named. */
export const PAYMENT_REQUIRED = 402;

export interface GatewayFailure {
  /**
   * A replacement message for the operator, or null when nothing specific is
   * known and the caller's own wording is the better one.
   *
   * Null rather than a generic sentence on purpose: a caller knows which
   * operation failed ("could not write a script", "could not choose moments")
   * and this module does not, so inventing a vaguer sentence here would lose
   * information rather than add it.
   */
  message: string | null;
  /** Whether the caller should try again on its own. Only ever true for a
   *  genuinely transient status. */
  retryable: boolean;
  /** Whether the gateway refused because the account has no budget left. The
   *  one failure here that no amount of waiting or retrying resolves. */
  budgetExhausted: boolean;
}

/** Every response body in the cause chain, parsed where it is JSON. */
function bodies(error: unknown): GatewayErrorBody[] {
  const found: GatewayErrorBody[] = [];

  for (const link of causeChain(error)) {
    const extras = link as Record<string, unknown>;

    // `responseBody` is the raw string an APICallError carries; `data` is the
    // same thing already parsed. Both are read because which one is populated
    // depends on whether the SDK could parse the response itself.
    if (typeof extras.responseBody === "string" && extras.responseBody !== "") {
      try {
        found.push(JSON.parse(extras.responseBody) as GatewayErrorBody);
      } catch {
        // An HTML error page or a truncated body. Not a classification signal,
        // and not a failure — the status is read independently below.
      }
    }

    if (typeof extras.data === "object" && extras.data !== null) {
      found.push(extras.data as GatewayErrorBody);
    }
  }

  return found;
}

/** The HTTP status behind a failure, wherever in the chain it sits. Local
 *  rather than `providerStatusCode` only so this module states its own rule;
 *  the two agree and are tested separately. */
function statusOf(error: unknown): number | undefined {
  for (const link of causeChain(error)) {
    const status = (link as { statusCode?: unknown }).statusCode;

    if (typeof status === "number") {
      return status;
    }
  }

  return undefined;
}

/**
 * Judges a gateway failure on its status and its error code, and on nothing
 * else.
 *
 * A spend limit is recognised from **either** signal alone: the status without
 * a readable body (a proxy that dropped it), or the code without a status (an
 * SDK version that reports it differently). Requiring both would make the
 * classification depend on which of two things happened to survive the trip.
 */
export function describeGatewayFailure(error: unknown): GatewayFailure {
  const status = statusOf(error);
  const parsed = bodies(error);

  const budgetExhausted =
    status === PAYMENT_REQUIRED ||
    parsed.some((body) => body.error?.type === BUDGET_EXCEEDED_TYPE);

  if (budgetExhausted) {
    // The gateway's own sentence carries the numbers — current spend and the
    // limit — which are the two figures somebody needs in order to decide how
    // much to add. Kept verbatim rather than summarised for that reason.
    const said = parsed.find((body) => body.error?.message)?.error?.message;

    return {
      message:
        "The AI Gateway has no budget left, so nothing could be generated." +
        (said ? ` It said: "${said}"` : "") +
        " This will not clear on its own — raise the spend limit or add credit " +
        "on the AI Gateway dashboard. Every scheduled run fails until it is done.",
      retryable: false,
      budgetExhausted: true,
    };
  }

  // The same rule `isRetryableProviderFailure` applies, stated here so this
  // module's answer does not depend on reading that one.
  const retryable = status === 429 || (status !== undefined && status >= 500);

  return { message: null, retryable, budgetExhausted: false };
}
