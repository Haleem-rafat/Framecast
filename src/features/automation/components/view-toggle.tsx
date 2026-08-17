"use client";

import { LayoutGrid, Table2 } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";

import { setAutomationViewAction } from "@/actions/canvas.action";
import { Button } from "@/components/ui/button";
import type { AutomationView } from "@/generated/prisma/enums";

/**
 * Canvas or table.
 *
 * Both survive, and the reason is that they answer different questions. A
 * canvas shows shape — "what is my kids channel doing", which is the question
 * the flat table could not answer and the whole reason the canvas exists. A
 * table is still the better tool at forty automations when the question is
 * "where is the one called Bedtime Stories", because it sorts and filters and a
 * canvas does neither.
 *
 * The choice is a column on `UserSetting`, not component state and not
 * `localStorage`: the page is server-rendered from that row alongside theme and
 * accent, so the chosen view arrives with the HTML and there is no flash of the
 * other one on every navigation.
 */
export function ViewToggle({ view }: { view: AutomationView }) {
  const [isPending, startTransition] = useTransition();

  const choose = (next: AutomationView) => {
    if (next === view || isPending) return;

    startTransition(async () => {
      const response = await setAutomationViewAction({ view: next });

      if (!response.ok) {
        toast.error("Could not switch view", { description: response.error.message });
      }
      // No success toast and no `router.refresh()`. The action revalidates
      // /automation, so the new view arrives on its own — announcing a
      // successful view switch would be telling the operator what they can
      // already see.
    });
  };

  return (
    <div
      className="bg-muted inline-flex items-center rounded-lg p-0.5"
      role="group"
      aria-label="How to show your automations"
    >
      <Button
        type="button"
        size="sm"
        variant={view === "CANVAS" ? "default" : "ghost"}
        aria-pressed={view === "CANVAS"}
        disabled={isPending}
        onClick={() => choose("CANVAS")}
      >
        <LayoutGrid />
        Canvas
      </Button>
      <Button
        type="button"
        size="sm"
        variant={view === "TABLE" ? "default" : "ghost"}
        aria-pressed={view === "TABLE"}
        disabled={isPending}
        onClick={() => choose("TABLE")}
      >
        <Table2 />
        Table
      </Button>
    </div>
  );
}
