import { describe, expect, it, vi } from "vitest";

import { PaddleClient } from "@/services/paddle.client";

describe("PaddleClient.createPortalUrl", () => {
  it("asks the sandbox API for a portal session for this subscription", async () => {
    const fetchClient = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ data: { urls: { general: { overview: "https://customer-portal.paddle.com/x" } } } }),
    );
    const client = new PaddleClient({ apiKey: "pdl_sdbx_key", environment: "sandbox" }, fetchClient);

    const url = await client.createPortalUrl("ctm_1", "sub_1");

    expect(url).toBe("https://customer-portal.paddle.com/x");
    const [target, init] = fetchClient.mock.calls[0]!;
    expect(target).toBe("https://sandbox-api.paddle.com/customers/ctm_1/portal-sessions");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer pdl_sdbx_key");
    expect(JSON.parse(String(init?.body))).toEqual({ subscription_ids: ["sub_1"] });
  });

  it("uses the live API in production", async () => {
    const fetchClient = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ data: { urls: { general: { overview: "https://p" } } } }),
    );
    await new PaddleClient({ apiKey: "k", environment: "production" }, fetchClient).createPortalUrl("ctm_1", "sub_1");
    expect(fetchClient.mock.calls[0]![0]).toBe("https://api.paddle.com/customers/ctm_1/portal-sessions");
  });

  it("throws a provider error, without the key, when Paddle refuses", async () => {
    const fetchClient = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ error: { detail: "forbidden" } }, { status: 403 }),
    );
    const client = new PaddleClient({ apiKey: "secret-key", environment: "sandbox" }, fetchClient);
    const error = await client.createPortalUrl("ctm_1", "sub_1").catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain("secret-key");
    expect(String((error as Error).message)).toContain("403");
  });
});

describe("PaddleClient.changePlan", () => {
  it("swaps the subscription's price, charging the difference now", async () => {
    const fetchClient = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: { id: "sub_1" } }));
    const client = new PaddleClient({ apiKey: "pdl_sdbx_key", environment: "sandbox" }, fetchClient);

    await client.changePlan("sub_1", "pri_pro");

    const [target, init] = fetchClient.mock.calls[0]!;
    expect(target).toBe("https://sandbox-api.paddle.com/subscriptions/sub_1");
    expect(init?.method).toBe("PATCH");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer pdl_sdbx_key");
    expect(JSON.parse(String(init?.body))).toEqual({
      items: [{ price_id: "pri_pro", quantity: 1 }],
      proration_billing_mode: "prorated_immediately",
    });
  });

  it("throws, without the key, when Paddle refuses", async () => {
    const fetchClient = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status: 400 }));
    const client = new PaddleClient({ apiKey: "secret-key", environment: "sandbox" }, fetchClient);
    const error = await client.changePlan("sub_1", "pri_pro").catch((e: Error) => e);
    expect(String((error as Error).message)).toContain("400");
    expect(String((error as Error).message)).not.toContain("secret-key");
  });
});
