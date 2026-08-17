"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { ArrowRight, Lightbulb, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { helpKey } from "@/features/onboarding/dismissal";
import { resolveHelpTopic } from "@/features/onboarding/help-topics";
import { useOnboarding } from "@/features/onboarding/components/onboarding-provider";

/**
 * The note that appears once, at the top of a screen you have not seen before.
 *
 * ## Why it is mounted by the layout and not by each page
 *
 * There are twenty-odd screens and more arriving. Wiring a hint into each page
 * means every future page is one forgotten import away from having no help at
 * all, which is precisely the failure this whole change is fixing — the old
 * tour covered five screens because five screens is what existed when somebody
 * remembered to add them. One mount point in the layout means the coverage
 * question is answered in `help-topics.ts` alone, where a test can read it.
 *
 * ## Why above the page title
 *
 * `main` is a flex column and this is its first child, so the note sits above
 * the `h1`. That reads oddly for a permanent fixture and correctly for this:
 * the first time you open a screen, the sentence explaining what the screen is
 * for should come before the screen. It is gone on the second visit, and the
 * heading is back where it always was.
 *
 * ## Motion
 *
 * None. It is rendered or it is not. An entrance animation on a panel that
 * appears above the page title would push the whole page down while somebody is
 * reading it, and a `prefers-reduced-motion` branch for a thing that should not
 * animate for anybody is a branch worth not having.
 */
export function HelpHint({ isOperator }: { isOperator: boolean }) {
  const pathname = usePathname();
  const { isDismissed, dismiss } = useOnboarding();
  const [expanded, setExpanded] = useState(false);

  const topic = resolveHelpTopic(pathname, isOperator);

  if (!topic || isDismissed(helpKey(topic.id))) {
    return null;
  }

  return (
    <aside
      // Labelled by its own heading, so a screen-reader user meets it as a
      // named region they can skip rather than as a wall of text in front of
      // the page they asked for.
      aria-labelledby={`help-hint-${topic.id}`}
      className="bg-muted/40 flex items-start gap-3 rounded-xl border border-dashed p-4"
    >
      <Lightbulb
        aria-hidden="true"
        className="text-muted-foreground mt-0.5 size-4 shrink-0"
      />

      <div className="min-w-0 flex-1 space-y-1">
        <h2
          id={`help-hint-${topic.id}`}
          className="text-sm leading-tight font-medium"
        >
          {topic.title}
        </h2>
        <p
          id={`help-hint-body-${topic.id}`}
          className={
            "text-muted-foreground text-sm leading-relaxed text-pretty " +
            // Clamped on a phone, whole on a laptop.
            //
            // These notes run to five or six sentences, which is three lines on
            // a laptop and eleven on a phone — enough that /automation opened on
            // a phone showed a paragraph of explanation and not one automation
            // above the fold. The screen the note is describing has to be
            // visible beside the note describing it.
            //
            // The default is a Tailwind class rather than state from
            // `useIsMobile`, deliberately: that hook reports false until it has
            // measured, so a JS-driven default would render the full note and
            // then collapse it, which is the same shove down the page in the
            // other direction.
            (expanded ? "" : "line-clamp-3 sm:line-clamp-none")
          }
        >
          {topic.body}
        </p>

        {/* Both links live in one row with a real gap between them.
            Left to the parent's `space-y-1` they were two inline-flex buttons
            flowing into each other, and on a phone they read as a single
            broken sentence: "Read more Make one video now". */}
        <div className="flex flex-wrap items-center gap-x-4">
          {/* Phone only. On a laptop the note is never clamped, so a control to
              unclamp it would do nothing. */}
          <Button
            variant="link"
            size="sm"
            className="h-auto px-0 py-1 font-normal sm:hidden"
            aria-expanded={expanded}
            aria-controls={`help-hint-body-${topic.id}`}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "Show less" : "Read more"}
          </Button>

          {topic.action && (
            <Button
              asChild
              variant="link"
              size="sm"
              className="h-auto px-0 py-1 font-normal"
            >
              <Link href={topic.action.href}>
                {topic.action.label}
                <ArrowRight />
              </Link>
            </Button>
          )}
        </div>
      </div>

      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:text-foreground -mt-1 -mr-1 size-7 shrink-0"
        onClick={() => dismiss(helpKey(topic.id))}
        // Names the screen it is closing. A page can only ever show one of
        // these, but the palette offers "bring the notes back" globally, and
        // "Close" on its own tells a screen-reader user nothing about which of
        // twenty notes they just heard.
        aria-label={`Close the note about ${topic.title}`}
      >
        <X />
      </Button>
    </aside>
  );
}
