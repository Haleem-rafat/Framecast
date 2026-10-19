import { describe, expect, it } from "vitest";

import { actionLabel } from "@/features/logs/action-labels";

describe("actionLabel", () => {
  it("names the actions people see most in plain words", () => {
    expect(actionLabel("voiceover.generate")).toBe("Narration recorded");
    expect(actionLabel("script.generate")).toBe("Script written");
    expect(actionLabel("automation.autoApprove")).toBe("Script approved automatically");
  });

  it("turns an action nobody named yet into words rather than code", () => {
    expect(actionLabel("schedule.topics.prune")).toBe("Schedule topics prune");
    expect(actionLabel("something.newThing")).toBe("Something new thing");
  });
});
