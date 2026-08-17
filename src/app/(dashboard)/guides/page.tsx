import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { Reveal } from "@/components/shared/reveal";
import { Badge } from "@/components/ui/badge";
import { buildGuide } from "@/features/onboarding/guides";
import { requireUser } from "@/server/session";
import { accountService } from "@/services/account.service";

export const metadata: Metadata = { title: "Guides" };

/**
 * Every screen in the studio, explained, in the order the sidebar lists them.
 *
 * ## Why this exists when the notes already do
 *
 * There was a note per screen and a five-step tour, and between them no way to
 * read the product. The notes appear one at a time, on the screen they describe
 * and only the first time you open it; the tour deliberately does one job and
 * stops. So an operator who wanted to know what the studio *can do* had to
 * visit twenty-odd screens and read twenty-odd notes in whatever order they
 * happened to click, and anyone who had dismissed them saw nothing at all.
 *
 * This is the page that answers "what is all of this". It writes nothing of its
 * own — see `buildGuide` for why every word here comes from `help-topics.ts` —
 * so there is exactly one description of each screen in the codebase, and it is
 * the same one that greets you when you arrive there.
 *
 * ## Why it is not in the sidebar
 *
 * It would be a twenty-fifth navigation entry that an operator needs twice: on
 * their first day, and on the day they wonder what a screen they have never
 * opened is for. Both times they reach it from somewhere they are already
 * looking — the Guides card on /settings, the ⌘K palette, or the dashboard's
 * own note. A permanent sidebar slot for a page nobody opens twice a month is
 * how sidebars stop being useful.
 */
export default async function GuidesPage() {
  const user = await requireUser();
  // The same read the layout makes to decide what the sidebar shows, for the
  // same reason: a member must not be handed a guide to /admin and /approvals,
  // which are two screens they cannot open. `requireUser` does not carry the
  // role — only the two operator-gated surfaces normally ask for it.
  const role = await accountService.roleFor(user.id);
  const guide = buildGuide(role === "OPERATOR");

  const total = guide.sections.reduce(
    (sum, section) => sum + section.entries.length,
    0,
  );

  return (
    <>
      <PageHeader
        title="Guides"
        description={`What every screen in Framecast is for, in the order the sidebar lists them. ${total} screens, and the same notes that appear on each one the first time you open it.`}
      />

      <Reveal>
        <div className="flex flex-col gap-10">
          {guide.sections.map((section) => (
            <section key={section.label} className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <h2 className="text-sm font-medium tracking-wide uppercase">
                  {section.label}
                </h2>
                <span
                  aria-hidden="true"
                  className="bg-border h-px flex-1"
                />
                <Badge variant="secondary" className="tabular-nums">
                  {section.entries.length}
                </Badge>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                {section.entries.map(({ item, topic }) => {
                  const Icon = item.icon;

                  return (
                    // The whole card is the link. On a phone a small "open"
                    // affordance in the corner of a text block is the hardest
                    // thing on the screen to hit.
                    <Link
                      key={item.href}
                      href={item.href}
                      className="group bg-card hover:border-primary/40 flex flex-col gap-2 rounded-xl border p-4 transition-colors"
                    >
                      <div className="flex items-center gap-2.5">
                        <div className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-lg">
                          <Icon className="size-4" />
                        </div>
                        <span className="min-w-0 flex-1 truncate font-medium">
                          {item.title}
                        </span>
                        <ArrowUpRight className="text-muted-foreground group-hover:text-foreground size-4 shrink-0 transition-colors" />
                      </div>

                      <p className="text-sm font-medium">{topic.title}</p>
                      <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
                        {topic.body}
                      </p>
                    </Link>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </Reveal>
    </>
  );
}
