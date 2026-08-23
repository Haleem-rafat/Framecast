import { describe, expect, it } from "vitest";

import { describeRefreshFailure } from "@/lib/oauth-refresh";

/**
 * Every body below is a real response shape from Google's token endpoint. The
 * first one is the exact body that produced the wrong advice on this
 * deployment, which is why it is first.
 */

describe("a revoked or expired grant", () => {
  // The failure this file was extracted for. The previous version classified
  // by searching `error_description` for "invalid_grant" — a string that never
  // appears there, because the description of invalid_grant is this prose. So
  // the one case where reconnecting IS the fix was reported as the case where
  // it probably is not, to an operator who had just reconnected.
  const body = JSON.stringify({
    error: "invalid_grant",
    error_description: "Token has been expired or revoked.",
  });

  it("tells the operator to reconnect, because that is the fix", () => {
    const failure = describeRefreshFailure(400, body);

    expect(failure.message).toMatch(/reconnect the channel/i);
    expect(failure.message).toMatch(/that will fix it/i);
  });

  it("does not tell them reconnecting may not help", () => {
    expect(describeRefreshFailure(400, body).message).not.toMatch(/may not help/i);
  });

  it("does not blame the deployment's credentials", () => {
    expect(describeRefreshFailure(400, body).message).not.toMatch(/deployment/i);
  });

  // Operator-actionable. Retrying a revoked grant in a loop is a slower way of
  // not working, and it hides the one action that would fix it.
  it("is not retryable", () => {
    expect(describeRefreshFailure(400, body).retryable).toBe(false);
  });
});

describe("a bad client configuration", () => {
  const body = JSON.stringify({
    error: "invalid_client",
    error_description: "The OAuth client was not found.",
  });

  // The opposite mistake: sending somebody to reconnect a channel that is
  // fine, against a problem only a deployment change can fix.
  it("points at the deployment rather than the channel", () => {
    const failure = describeRefreshFailure(401, body);

    expect(failure.message).toMatch(/deployment/i);
    expect(failure.message).toMatch(/may not help/i);
  });

  it("quotes Google's own description", () => {
    expect(describeRefreshFailure(401, body).message).toContain(
      "The OAuth client was not found.",
    );
  });

  it("is not retryable", () => {
    expect(describeRefreshFailure(401, body).retryable).toBe(false);
  });
});

describe("a transient failure", () => {
  it("says it will be tried again, and is retryable", () => {
    const failure = describeRefreshFailure(503, "<html>Service Unavailable</html>");

    expect(failure.message).toMatch(/clears on its own/i);
    expect(failure.retryable).toBe(true);
  });

  // A 5xx is often an HTML error page. Whatever the message says, it must not
  // be a page of markup.
  it("does not put a page of HTML in front of the operator", () => {
    expect(describeRefreshFailure(503, "<html>".padEnd(4000, "x"))).toMatchObject({
      message: expect.not.stringContaining("xxxxxxxxxxxxxxxxxxxx"),
    });
  });
});

describe("a body that is not JSON at all", () => {
  it("still produces a sentence rather than throwing", () => {
    expect(() => describeRefreshFailure(400, "not json")).not.toThrow();
    expect(describeRefreshFailure(400, "not json").message).toContain("400");
  });
});
