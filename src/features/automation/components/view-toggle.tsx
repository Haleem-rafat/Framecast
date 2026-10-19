"use client";

import { LayoutGrid, Workflow } from "lucide-react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { AUTOMATION_LAYOUT_COOKIE, type AutomationLayout } from "@/features/automation/layout";


/**
 * Grid (cards) or canvas for the Automations tab. Grid is the default; the
 * choice is kept in a cookie for a year and the address carries it too, so a
 * shared link opens the same view.
 */
export function ViewToggle({ view }: { view: AutomationLayout }) {
  const router = useRouter();

  const choose = (next: AutomationLayout) => {
    if (next === view) return;
    document.cookie = `${AUTOMATION_LAYOUT_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    router.push(`/automation?tab=list&view=${next}`);
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
        variant={view === "grid" ? "default" : "ghost"}
        aria-pressed={view === "grid"}
        onClick={() => choose("grid")}
      >
        <LayoutGrid />
        Grid
      </Button>
      <Button
        type="button"
        size="sm"
        variant={view === "canvas" ? "default" : "ghost"}
        aria-pressed={view === "canvas"}
        onClick={() => choose("canvas")}
      >
        <Workflow />
        Canvas
      </Button>
    </div>
  );
}
