import { describe, expect, it } from "vitest";

import {
  BUDGET_EXCEEDED_TYPE,
  PAYMENT_REQUIRED,
  describeGatewayFailure,
} from "@/lib/gateway-failure";
import { ProviderError } from "@/lib/errors";

/**
 * The body below is the real one, copied out of `framecast-worker-staging-1`
 * on 2026-08-27. It is first because it is the failure this module was written
 * for: the gateway's spend limit was reached on 25 August and every scheduled
 * run for the next two days died on it, while the operator was told only "The
 * model provider failed to generate a script."
 */
const BUDGET_BODY = JSON.stringify({
  error: {
    message:
      "Team budget exceeded. Current spend: $30.00, limit: $30.00. Please " +
      "contact your administrator to increase the budget.",
    type: "quota_for_entity_exceeded",
  },
});

/** The AI SDK's shape, as it actually arrives: the status on the error, the
 *  raw body beside it, and a name that lies about both. */
function gatewayError(
  overrides: { status?: number; body?: string; name?: string; message?: string } = {},
): Error {
  const error = new Error(
    overrides.message ??
      "Team budget exceeded. Current spend: $30.00, limit: $30.00. Please " +
        "contact your administrator to increase the budget.",
  );

  error.name = overrides.name ?? "GatewayInternalServerError";
  Object.assign(error, {
    statusCode: overrides.status ?? 402,
    responseBody: overrides.body ?? BUDGET_BODY,
    url: "https://ai-gateway.vercel.sh/v4/ai/language-model",
  });

  return error;
}

describe("a spend limit that has been reached", () => {
  it("is recognised as an exhausted budget", () => {
    expect(describeGatewayFailure(gatewayError()).budgetExhausted).toBe(true);
  });

  // Retrying a spend limit is a slower way of not working, and it hides the one
  // action that fixes it.
  it("is not retryable", () => {
    expect(describeGatewayFailure(gatewayError()).retryable).toBe(false);
  });

  it("says what is wrong and where to fix it", () => {
    const { message } = describeGatewayFailure(gatewayError());

    expect(message).toMatch(/budget/i);
    expect(message).toMatch(/AI Gateway/i);
  });

  it("says it will not fix itself, because it will not", () => {
    const { message } = describeGatewayFailure(gatewayError());

    expect(message).toMatch(/will not (clear|fix)/i);
    expect(message).not.toMatch(/try again|usually clears/i);
  });

  it("keeps the gateway's own figures, which say how much to add", () => {
    expect(describeGatewayFailure(gatewayError()).message).toContain("$30.00");
  });

  /**
   * The lesson of `oauth-refresh.ts`, applied to a different provider: classify
   * on the machine-readable code, never the prose. `GatewayInternalServerError`
   * is the *name* of a 402, so anything keying off the name reads a spend limit
   * as a transient server fault and retries it forever.
   */
  it("is not read as a server fault despite its name", () => {
    const failure = describeGatewayFailure(gatewayError());

    expect(failure.retryable).toBe(false);
    expect(failure.message).not.toMatch(/server|internal/i);
  });

  it("is found through the wrapper the services throw", () => {
    const wrapped = new ProviderError(
      "ANTHROPIC",
      "The model provider failed to generate a script.",
      false,
      { cause: gatewayError() },
    );

    expect(describeGatewayFailure(wrapped).budgetExhausted).toBe(true);
  });

  it("is recognised from the status alone, with no body to read", () => {
    expect(
      describeGatewayFailure(gatewayError({ status: 402, body: "" })).budgetExhausted,
    ).toBe(true);
  });

  it("is recognised from the code alone, with no status to read", () => {
    const error = new Error("Team budget exceeded.");
    Object.assign(error, { responseBody: BUDGET_BODY });

    expect(describeGatewayFailure(error).budgetExhausted).toBe(true);
  });
});

describe("failures that are not a spend limit", () => {
  it("treats a rate limit as transient and retryable", () => {
    const failure = describeGatewayFailure(gatewayError({ status: 429, body: "" }));

    expect(failure.budgetExhausted).toBe(false);
    expect(failure.retryable).toBe(true);
  });

  it("treats a real server fault as retryable", () => {
    const failure = describeGatewayFailure(gatewayError({ status: 503, body: "" }));

    expect(failure.budgetExhausted).toBe(false);
    expect(failure.retryable).toBe(true);
  });

  it("treats a bad request as neither", () => {
    const failure = describeGatewayFailure(gatewayError({ status: 400, body: "" }));

    expect(failure.budgetExhausted).toBe(false);
    expect(failure.retryable).toBe(false);
  });

  it("does not invent a budget problem out of an unrelated error", () => {
    const failure = describeGatewayFailure(new Error("socket hang up"));

    expect(failure.budgetExhausted).toBe(false);
    expect(failure.retryable).toBe(false);
    expect(failure.message).toBeNull();
  });

  it("does not read the word budget in prose as the code", () => {
    // A model that happens to write about budgets is not a spend limit.
    const error = new Error("model wrote about the federal budget");
    Object.assign(error, { statusCode: 200 });

    expect(describeGatewayFailure(error).budgetExhausted).toBe(false);
  });

  it("survives a body that is not JSON at all", () => {
    const failure = describeGatewayFailure(
      gatewayError({ status: 502, body: "<html>bad gateway</html>" }),
    );

    expect(failure.budgetExhausted).toBe(false);
    expect(failure.retryable).toBe(true);
  });
});

describe("the signals it classifies on", () => {
  // Asserted through the exported constants rather than by repeating the
  // strings, so editing one of them cannot leave a test passing against a copy.
  it("uses the gateway's own code, applied to a body it has never seen", () => {
    const error = new Error("some other wording entirely");
    Object.assign(error, {
      responseBody: JSON.stringify({ error: { type: BUDGET_EXCEEDED_TYPE } }),
    });

    expect(describeGatewayFailure(error).budgetExhausted).toBe(true);
  });

  it("uses the payment-required status, whatever the body says", () => {
    const error = new Error("no body worth reading");
    Object.assign(error, { statusCode: PAYMENT_REQUIRED });

    expect(describeGatewayFailure(error).budgetExhausted).toBe(true);
  });

  it("reads a body the SDK already parsed onto `data`", () => {
    const error = new Error("parsed by the sdk");
    Object.assign(error, { data: { error: { type: BUDGET_EXCEEDED_TYPE } } });

    expect(describeGatewayFailure(error).budgetExhausted).toBe(true);
  });
});
