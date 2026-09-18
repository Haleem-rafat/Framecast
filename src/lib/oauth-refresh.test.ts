import { describe, expect, it } from "vitest";

import {
  classifyRefreshFailure,
  describeRefreshFailure,
  formatTokenAge,
  looksLikeTestingModeExpiry,
} from "@/lib/oauth-refresh";

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

// Google kills refresh tokens seven days after issue for an app whose OAuth
// consent screen is in Testing, with the same invalid_grant body as a real
// revocation. The token's age is the only way to tell, and the only way to
// stop the operator reconnecting every week is to name the console setting.
describe("a grant that died at Testing mode's seven days", () => {
  const body = JSON.stringify({
    error: "invalid_grant",
    error_description: "Token has been expired or revoked.",
  });
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  it("names the Testing publishing status and the exact console path", () => {
    const failure = describeRefreshFailure(400, body, { tokenAgeMs: 7 * DAY + 3 * HOUR });

    expect(failure.kind).toBe("revoked");
    expect(failure.message).toContain("7 days, 3 hours after it was connected");
    expect(failure.message).toMatch(/Testing/);
    expect(failure.message).toContain(
      "APIs & Services → OAuth consent screen → Publishing status → Publish app",
    );
    expect(failure.message).toMatch(/reconnect the channel/i);
    expect(failure.retryable).toBe(false);
  });

  it("still reads as Testing mode when the first refusal came a day late", () => {
    // Nothing refreshes at the instant of expiry; the collector's daily pass
    // or the next publish is the first to find out.
    expect(looksLikeTestingModeExpiry(8 * DAY)).toBe(true);
    expect(looksLikeTestingModeExpiry(7 * DAY - 30 * 60 * 1000)).toBe(true);
  });

  it("does not blame Testing mode for a token that died early", () => {
    const failure = describeRefreshFailure(400, body, { tokenAgeMs: 2 * DAY + 5 * HOUR });

    expect(looksLikeTestingModeExpiry(2 * DAY)).toBe(false);
    expect(failure.message).not.toMatch(/Testing/);
    expect(failure.message).toContain("2 days, 5 hours old");
    expect(failure.message).toMatch(/that will fix it/i);
  });

  it("does not blame Testing mode for a token that lived well past a week", () => {
    expect(looksLikeTestingModeExpiry(30 * DAY)).toBe(false);
    expect(describeRefreshFailure(400, body, { tokenAgeMs: 30 * DAY }).message).not.toMatch(
      /Testing/,
    );
  });

  it("says nothing about age when the age is unknown", () => {
    const failure = describeRefreshFailure(400, body, { tokenAgeMs: null });

    expect(failure.message).not.toMatch(/Testing|old when/);
    expect(failure.message).toMatch(/that will fix it/i);
  });

  // Testing mode is a property of the deployment's OAuth app; it only ever
  // shows up as invalid_grant. A misconfigured client must never borrow it.
  it("never attaches the Testing-mode advice to a client error", () => {
    const clientBody = JSON.stringify({ error: "invalid_client" });

    expect(
      describeRefreshFailure(401, clientBody, { tokenAgeMs: 7 * DAY }).message,
    ).not.toMatch(/Testing/);
  });
});

describe("classifyRefreshFailure", () => {
  it("reads Google's error code, not its prose", () => {
    expect(classifyRefreshFailure(400, JSON.stringify({ error: "invalid_grant" }))).toBe(
      "revoked",
    );
    expect(
      classifyRefreshFailure(400, JSON.stringify({ error_description: "invalid_grant" })),
    ).toBe("client");
    expect(classifyRefreshFailure(401, JSON.stringify({ error: "invalid_client" }))).toBe(
      "client",
    );
  });

  // A 5xx is Google's side even when the body happens to say invalid_grant.
  it("treats any 5xx as transient", () => {
    expect(classifyRefreshFailure(502, JSON.stringify({ error: "invalid_grant" }))).toBe(
      "transient",
    );
  });

  it("survives a JSON body that is not an object", () => {
    expect(classifyRefreshFailure(400, "null")).toBe("client");
  });
});

describe("formatTokenAge", () => {
  it("writes an age the way a person would", () => {
    expect(formatTokenAge(10 * 60 * 1000)).toBe("under an hour");
    expect(formatTokenAge(60 * 60 * 1000)).toBe("1 hour");
    expect(formatTokenAge(24 * 60 * 60 * 1000)).toBe("1 day");
    expect(formatTokenAge((7 * 24 + 2) * 60 * 60 * 1000)).toBe("7 days, 2 hours");
  });
});
