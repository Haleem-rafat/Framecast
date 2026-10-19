import { describe, expect, it, vi } from "vitest";

import { clientIp, PaddleIpList } from "@/lib/paddle-ips";

describe("clientIp", () => {
  it("takes the first address Caddy put in X-Forwarded-For", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "34.237.3.244, 10.0.0.2" }))).toBe("34.237.3.244");
  });

  it("returns null when there is no forwarded address", () => {
    expect(clientIp(new Headers())).toBeNull();
  });
});

describe("PaddleIpList", () => {
  const response = () =>
    Response.json({ data: { ipv4_cidrs: ["34.237.3.244/32", "52.11.166.252/32"] } });

  it("allows Paddle's addresses and nothing else", async () => {
    const list = new PaddleIpList("production", vi.fn<typeof fetch>().mockResolvedValue(response()));
    expect(await list.allows("34.237.3.244")).toBe(true);
    expect(await list.allows("1.2.3.4")).toBe(false);
    expect(await list.allows(null)).toBe(false);
  });

  it("asks the live endpoint in production and the sandbox one otherwise", async () => {
    const live = vi.fn<typeof fetch>().mockResolvedValue(response());
    await new PaddleIpList("production", live).allows("1.1.1.1");
    expect(String(live.mock.calls[0]![0])).toBe("https://api.paddle.com/ips");

    const sandbox = vi.fn<typeof fetch>().mockResolvedValue(response());
    await new PaddleIpList("sandbox", sandbox).allows("1.1.1.1");
    expect(String(sandbox.mock.calls[0]![0])).toBe("https://sandbox-api.paddle.com/ips");
  });

  it("fetches the list once an hour, not on every delivery", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const list = new PaddleIpList("production", fetcher);
    await list.allows("34.237.3.244");
    await list.allows("52.11.166.252");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("lets deliveries through when Paddle's list cannot be fetched, since the signature still protects", async () => {
    const list = new PaddleIpList("production", vi.fn<typeof fetch>().mockRejectedValue(new Error("down")));
    expect(await list.allows("9.9.9.9")).toBe(true);
  });
});
