import { describe, expect, it } from "vitest";

import { recurringCharacterInstruction } from "@/lib/recurring-character";

// The brief and topic from the render that exposed the defect: the script came
// back "Meet Pip, a brass lantern with…" while every frame showed the bear.
const PIP =
  "Pip, a small round bear cub with soft honey-brown fur, a cream muzzle and a " +
  "red knitted scarf.";

describe("recurringCharacterInstruction — when it says nothing at all", () => {
  it("says nothing for a live-action channel, however good its character brief", () => {
    // A live-action channel has no recurring character in any sense the
    // pipeline can honour: its pictures are stock clips of whoever the
    // photographer filmed. Instructing the writer to pin a protagonist would
    // guarantee a mismatch rather than prevent one.
    expect(
      recurringCharacterInstruction({ footageStyle: "LIVE_ACTION", characterBrief: PIP }),
    ).toBeNull();
  });

  it("says nothing for a cartoon channel", () => {
    // Checked rather than assumed, and the check is in the footage path:
    // `FOOTAGE_SEARCH_PLAN.CARTOON` is a Pixabay search plan, and
    // `collectIllustrated` — the only reader of `characterBrief` there — runs
    // for ILLUSTRATED alone. A cartoon channel's clips show a different
    // creature every section no matter what the narration claims.
    expect(
      recurringCharacterInstruction({ footageStyle: "CARTOON", characterBrief: PIP }),
    ).toBeNull();
  });

  it("says nothing for an illustrated channel whose brief is empty, null, or blank", () => {
    // Three spellings of one state — "nobody has written this down" — and
    // there is nothing to tell the writer about a character nobody described.
    // Such a channel cannot collect footage either: `collectIllustrated`
    // refuses it by name.
    for (const characterBrief of [null, "", "   \n  "]) {
      expect(
        recurringCharacterInstruction({ footageStyle: "ILLUSTRATED", characterBrief }),
      ).toBeNull();
    }
  });

  it("says nothing for a video whose project has no channel or no brand row", () => {
    expect(recurringCharacterInstruction(null)).toBeNull();
    expect(recurringCharacterInstruction(undefined)).toBeNull();
  });
});

describe("recurringCharacterInstruction — what it tells the writer", () => {
  const instruction = recurringCharacterInstruction({
    footageStyle: "ILLUSTRATED",
    characterBrief: PIP,
  });

  it("is produced for an illustrated channel that has a brief", () => {
    expect(instruction).not.toBeNull();
  });

  it("quotes the operator's brief verbatim rather than summarising it", () => {
    // The same text the illustrator is conditioned on. A second, paraphrased
    // description would be a second chance for the words and the pictures to
    // disagree, which is the defect being fixed.
    expect(instruction).toContain(PIP);
  });

  it("pins what the character *is*, not merely what they are called", () => {
    // The failure kept the name and threw away the species: "Meet Pip, a brass
    // lantern". An instruction that named the character without fixing their
    // kind would have prevented nothing.
    expect(instruction).toContain("exactly what that description says they are");
    expect(instruction).toContain("does not change");
  });

  it("forbids lending the character's name to anything else in the story", () => {
    expect(instruction).toContain("Their name belongs to them alone");
  });

  it("says what to do when the topic names a different protagonist", () => {
    // The regression itself, stated as an instruction rather than left for the
    // model to infer — inferring it is exactly what it failed to do.
    expect(instruction).toContain("If the topic names or implies some other main character");
    expect(instruction).toContain("meets, finds, helps, or is affected by");
    expect(instruction).toContain("never the recurring character renamed");
    // The worked example is the observed failure, resolved the right way.
    expect(instruction).toContain("does not become a lantern");
  });

  it("leaves the operator's own prompt in charge of everything else", () => {
    // This arrives beside an operator-authored template. Length, structure,
    // tone and section count are still that template's to decide, and saying
    // so keeps this instruction from being read as a licence to override it.
    expect(instruction).toContain("the length, the structure, the tone");
    expect(instruction).toContain("is unchanged by this");
  });
});
