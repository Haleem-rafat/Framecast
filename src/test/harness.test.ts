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

  it("forces PREVIEW_MODE off so tests never hit stubbed auth", () => {
    expect(process.env.PREVIEW_MODE).toBe("false");
  });
});
