/**
 * Paddle sends webhooks only from the addresses its `/ips` endpoint lists.
 * The webhook route checks the sender against that list as a second lock
 * beside the signature. The list is fetched, never hard-coded (Paddle can
 * change it), and kept for an hour.
 *
 * If the list cannot be fetched, deliveries are let through: the signature
 * check still stands, and refusing every payment event because Paddle's IP
 * endpoint blinked would lose real subscriptions.
 */
const ENDPOINT = {
  production: "https://api.paddle.com/ips",
  sandbox: "https://sandbox-api.paddle.com/ips",
} as const;

const TTL_MS = 60 * 60 * 1000;

/** The original client address. Caddy puts it first in X-Forwarded-For. */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip") || null;
}

export class PaddleIpList {
  private cached: { ips: Set<string>; at: number } | null = null;

  constructor(
    private readonly environment: keyof typeof ENDPOINT,
    // Looked up per call, so a replaced global fetch (tests) is honoured.
    private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
  ) {}

  async allows(ip: string | null): Promise<boolean> {
    const list = await this.load();
    if (list === null) return true;
    return ip !== null && list.has(ip);
  }

  private async load(): Promise<Set<string> | null> {
    if (this.cached && Date.now() - this.cached.at < TTL_MS) return this.cached.ips;
    try {
      const response = await this.fetcher(ENDPOINT[this.environment]);
      if (!response.ok) return this.cached?.ips ?? null;
      const body = (await response.json()) as { data?: { ipv4_cidrs?: string[] } };
      // Paddle lists single hosts as /32; anything wider is not expected.
      const ips = new Set((body.data?.ipv4_cidrs ?? []).map((cidr) => cidr.replace(/\/32$/, "")));
      if (ips.size === 0) return this.cached?.ips ?? null;
      this.cached = { ips, at: Date.now() };
      return ips;
    } catch {
      return this.cached?.ips ?? null;
    }
  }
}
