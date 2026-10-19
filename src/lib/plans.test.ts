import { describe, expect, it } from "vitest";

import { PAID_TIERS, PLANS, creditsFor, outOfCredits, tierForPriceId } from "@/lib/plans";

describe("plans", () => {
  it("prices and credits match what the site sells", () => {
    expect(PLANS.TRIAL).toMatchObject({ monthlyUsd: 0, credits: 3, watermark: true });
    expect(PLANS.CREATOR).toMatchObject({ monthlyUsd: 29, credits: 20, watermark: false });
    expect(PLANS.PRO).toMatchObject({ monthlyUsd: 79, credits: 60, marketing: true });
    expect(PLANS.AGENCY).toMatchObject({ monthlyUsd: 199, credits: 180, seats: 3, marketing: true });
    expect(PAID_TIERS).toEqual(["CREATOR", "PRO", "AGENCY"]);
  });

  it("a Short costs 1 credit and a long video 5", () => {
    expect(creditsFor("VERTICAL")).toBe(1);
    expect(creditsFor("LANDSCAPE")).toBe(5);
  });

  it("maps a Paddle price id to its tier and nothing else", () => {
    const prices = { CREATOR: "pri_c", PRO: "pri_p", AGENCY: "pri_a" };
    expect(tierForPriceId("pri_p", prices)).toBe("PRO");
    expect(tierForPriceId("pri_unknown", prices)).toBeNull();
    expect(tierForPriceId("", {})).toBeNull();
  });

  it("an unlimited account is never out of credits", () => {
    expect(outOfCredits({ credits: 0, unlimited: true }, 5)).toBe(false);
    expect(outOfCredits({ credits: 4, unlimited: false }, 5)).toBe(true);
    expect(outOfCredits({ credits: 5, unlimited: false }, 5)).toBe(false);
  });
});
