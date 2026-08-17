"use client";

import { ListChecks, Lightbulb, PlayCircle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CHECKLIST_KEY } from "@/features/onboarding/dismissal";
import { useOnboarding } from "@/features/onboarding/components/onboarding-provider";

/**
 * Where onboarding goes to be found again.
 *
 * Somebody who pressed Escape on day one has no way back to any of this
 * otherwise, and "I dismissed the thing that explains the product" is a
 * one-way door nobody should be able to walk through. It lives on /settings
 * because that is the page an operator already looks at when they want to
 * change how the studio behaves — and because /settings is reachable from the
 * sidebar, the account menu and the phone dock's More sheet, so it is findable
 * from all three navigation surfaces without adding a fourth control to any of
 * them. The ⌘K palette offers the same three commands for anyone who would
 * rather type.
 *
 * Three buttons rather than one "reset onboarding", because the three surfaces
 * are not equally welcome. The tour is a modal walkthrough and asking for the
 * quiet screen notes back must not summon it.
 */
export function GuidesCard() {
  const { requestTour, restoreHelpHints, restore } = useOnboarding();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Guides</CardTitle>
        <CardDescription>
          Everything onboarding shows you can be brought back. What you have
          read is remembered against your account, so it follows you to another
          browser — and so does putting it back.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={requestTour}>
          <PlayCircle />
          Replay the welcome tour
        </Button>

        <Button
          variant="outline"
          onClick={() => {
            restoreHelpHints();
            toast.success("Screen notes are back", {
              description:
                "Each one appears again the next time you open that screen.",
            });
          }}
        >
          <Lightbulb />
          Bring back the screen notes
        </Button>

        <Button
          variant="outline"
          onClick={() => {
            restore([CHECKLIST_KEY]);
            toast.success("Setup checklist restored", {
              description:
                "It is back at the top of the dashboard — unless every step on it is already done, in which case there is nothing left to show.",
            });
          }}
        >
          <ListChecks />
          Show the setup checklist
        </Button>
      </CardContent>
    </Card>
  );
}
