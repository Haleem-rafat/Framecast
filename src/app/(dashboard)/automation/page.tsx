import type { Metadata } from "next";
import Link from "next/link";
import { Repeat2, Sparkles } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Reveal } from "@/components/shared/reveal";
import { Button } from "@/components/ui/button";
import { AutomationTable } from "@/features/automation/components/automation-table";
import { NewAutomationMenu } from "@/features/automation/components/new-automation-menu";
import { ReadinessNotice } from "@/features/automation/components/readiness-notice";
import { requireUser } from "@/server/session";
import { automationListService } from "@/services/automation-list.service";
import { automationService } from "@/services/automation.service";

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
 */
export default async function AutomationPage() {
  const user = await requireUser();

  const [setup, automations] = await Promise.all([
    automationService.getSetup(user.id),
    automationListService.list(user.id),
  ]);

  const ready = setup.blockers.length === 0 && setup.prompt !== null;

  return (
    <>
      <PageHeader
        title="Automation"
        description="Everything that makes videos on a repeating cadence, in one list — what it is, where it publishes, when it next runs and whether it is working. Publishing stays yours."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* The one-shot flow, kept at the top of the screen it is most
                often reached from. Deliberately not the primary button: this
                page is about the things that run without anybody present, and
                the primary action on it should be making another one. */}
            <Button asChild variant="outline">
              <Link href="/automation/generate">
                <Sparkles />
                Make one video now
              </Link>
            </Button>
            {/* Offered whether or not the account is ready. The old lists hid
                their create button behind the same readiness check that hid
                the list, which left an operator with a blocked account looking
                at a screen with nothing on it and nothing to press. The create
                forms carry the gate that matters, and they explain it. Hidden
                only when there are no rows, because the empty state below
                already offers the same menu and two of them is noise. */}
            {automations.length > 0 && <NewAutomationMenu />}
          </div>
        }
      />

      {!ready && <ReadinessNotice blockers={setup.blockers} />}

      <Reveal>
        <AutomationTable
          automations={automations}
          empty={
            <EmptyState
              icon={Repeat2}
              title="Nothing runs on its own yet"
              description="An automation is a cadence and a list of subjects: Framecast writes, narrates and renders one video each time it comes round, and stops when the list runs out rather than inventing a topic. Start with a series if the videos belong to one show."
              action={
                // Offered even when the account is not ready, because the
                // create form's own gate explains what is missing better than a
                // hidden button does — and a screen with no rows and no button
                // is a dead end.
                <NewAutomationMenu />
              }
            />
          }
        />
      </Reveal>
    </>
  );
}
