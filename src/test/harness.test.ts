import { describe, expect, it } from "vitest";

describe("test harness", () => {
  it("resolves `server-only` to a no-op", async () => {
    // Every service in this repo imports it. Without the alias in
    // vitest.config.ts the package throws on import and every future service
    // test fails before reaching anything under test.
    await expect(import("server-only")).resolves.toBeDefined();
  });

  it("loads environment variables from .env.local", () => {
    const databaseUrl =
      process.env.DATABASE_URL ?? process.env.POSTGRES_PRISMA_URL;

    expect(databaseUrl).toBeTruthy();
  });

  it("loads the validated server env without throwing", async () => {
    // config/env.ts parses process.env through a Zod schema at import time and
    // throws if it's invalid. There is no stubbed auth path anymore — every
    // test run exercises the real schema, so this catches a broken .env.local
    // or a schema regression before any service test does.
    const { env } = await import("@/config/env");

    expect(env.DATABASE_URL).toBeTruthy();
  });
});
