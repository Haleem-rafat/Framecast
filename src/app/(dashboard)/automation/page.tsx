import type { Metadata } from "next";
import Link from "next/link";
import { Repeat2, Sparkles } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Reveal } from "@/components/shared/reveal";
import { AutomationCards } from "@/features/automation/components/automation-cards";
import { GenerateModes } from "@/features/automation/components/generate-modes";
import { NewAutomationMenu } from "@/features/automation/components/new-automation-menu";
import { ReadinessNotice } from "@/features/automation/components/readiness-notice";
import { cn } from "@/lib/utils";
import { requireUser } from "@/server/session";
import { automationListService } from "@/services/automation-list.service";
import { automationService } from "@/services/automation.service";
import { easyModeService } from "@/services/easy-mode.service";

export const metadata: Metadata = { title: "Automation" };

/**
 * Everything that makes videos on a repeating cadence.
 *
 * ## What this page used to be
 *
 * Three routes. `/automation` was a one-click generator with links out;
 * `/automation/series` was a table of shows; `/automation/schedules` was a
 * stack of cards listing the same shows *again*, alongside the schedules that
 * belonged to no show. Three screens, two visual languages, one idea. An
 * operator could not tell them apart, and they were right not to be able to —
 * a series is a schedule with a recipe attached, and that is a fact about this
 * codebase, not about their work.
 *
 * Now there is one table with one row per automation, and the retired routes
 * redirect here rather than 404ing a bookmark. The one-click generator moved to
 * `/automation/generate`, because it is genuinely a different thing — one video
 * now, not a cadence — and its button is the first thing in this header.
 *
 * ## Why the readiness notice sits above the table rather than replacing it
 *
 * Both old lists hid themselves entirely behind `ReadinessNotice`, which was
 * defensible when the notice stood between an operator and a *create* form that
 * would spend money. It is not defensible for a list: an account that has lost
 * its ElevenLabs key still has nine automations that will start skipping runs,
 * and hiding them is hiding exactly the thing the operator needs to look at.
 * The notice explains why nothing is producing; the table below it still says
 * what "nothing" consists of.
 *
 * The create forms keep their own gates — `/automation/series/new` re-checks
 * with the two extra conditions a series has — so nothing here weakens the
 * rule that a run is refused before the first billed call.
 *
 * ## Cards
 *
 * One card per automation (see AutomationCards). The canvas and the table
 * that used to sit here showed the same rows twice and both read as broken
 * once old failures piled up; a card says in one line whether it is working
 * and what fixes it.
 */
export default async function AutomationPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const user = await requireUser();
  const { tab: requested } = await searchParams;

  const [setup, automations, easySetup] = await Promise.all([
    automationService.getSetup(user.id),
    automationListService.list(user.id),
    easyModeService.getSetup(user.id),
  ]);

  // Someone with nothing running yet came here to make a video; someone with
  // automations came to see them. A tab in the address always wins.
  const tab: "make" | "list" =
    requested === "make" || requested === "list"
      ? requested
      : automations.length > 0
        ? "list"
        : "make";
  const ready = setup.blockers.length === 0 && setup.prompt !== null;

  return (
    <>
      <PageHeader
        title="Automation"
        description="Make one video now, or set up videos that make themselves on a schedule."
        actions={tab === "list" && automations.length > 0 ? <NewAutomationMenu /> : undefined}
      />

      <nav aria-label="Automation" className="bg-muted inline-flex w-fit rounded-lg p-1">
        {(
          [
            ["make", "Make a video", Sparkles],
            ["list", `Automations${automations.length ? ` (${automations.length})` : ""}`, Repeat2],
          ] as const
        ).map(([value, label, Icon]) => (
          <Link
            key={value}
            href={`/automation?tab=${value}`}
            aria-current={tab === value ? "page" : undefined}
            className={cn(
              "text-muted-foreground hover:text-foreground flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              tab === value && "bg-background text-foreground shadow-sm",
            )}
          >
            <Icon className="size-4" />
            {label}
          </Link>
        ))}
      </nav>

      {tab === "make" ? (
        easySetup.blockers.length > 0 || !easySetup.prompt ? (
          <ReadinessNotice blockers={easySetup.blockers} />
        ) : (
          <GenerateModes
            channels={easySetup.channels}
            projects={easySetup.projects}
            prompt={easySetup.prompt}
          />
        )
      ) : (
        <>
          {!ready && <ReadinessNotice blockers={setup.blockers} />}
          <Reveal>
            <AutomationCards
              automations={automations}
              empty={
                <EmptyState
                  icon={Repeat2}
                  title="Nothing runs on its own yet"
                  description="An automation makes one video each time it comes round, from a list of topics, and stops when the list runs out. Start with a series if the videos belong to one show."
                  action={<NewAutomationMenu />}
                />
              }
            />
          </Reveal>
        </>
      )}
    </>
  );
}
