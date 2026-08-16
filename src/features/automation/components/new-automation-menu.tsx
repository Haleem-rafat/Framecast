"use client";

import Link from "next/link";
import { ChevronDown, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AUTOMATION_KIND_ORDER, AUTOMATION_KINDS } from "@/features/automation/kinds";

/**
 * One button for "start something that repeats", rather than one button per
 * kind.
 *
 * Two buttons in the header was the old arrangement, and it forced the choice
 * before explaining it: an operator who does not already know the difference
 * between a series and a topic queue cannot pick between two bare labels. A
 * menu can carry a sentence under each entry, which is the only place in the
 * whole screen that distinction now has to be drawn — and it is drawn at the
 * moment the operator is actually choosing.
 *
 * It also holds the line at one control as kinds are added. The shorts release
 * cadence arriving next appears here by existing, because the entries are read
 * off `AUTOMATION_KINDS` rather than listed again.
 */
export function NewAutomationMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>
          <Plus />
          New automation
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      {/* Wide enough for the sentences it carries. At `max-w-xs` each blurb
          wrapped to three or four cramped lines and the three entries read as
          one grey block — the explanation that justifies the menu existing was
          the part that got squeezed. The viewport clamp keeps it inside a
          360px phone, where an unclamped 26rem would overflow the screen. */}
      <DropdownMenuContent
        align="end"
        className="w-[min(26rem,calc(100vw-2rem))] p-1.5"
      >
        {AUTOMATION_KIND_ORDER.map((kind) => {
          const meta = AUTOMATION_KINDS[kind];
          const Icon = meta.icon;

          return (
            <DropdownMenuItem key={kind} asChild>
              {/* Only spacing is overridden here. `DropdownMenuItem` already
                  lays the row out as a centred flex line and sizes a bare
                  `<svg>` for itself, and fighting either from the child of an
                  `asChild` slot means two class strings concatenated with no
                  `tailwind-merge` between them — whichever utility Tailwind
                  happened to emit last would win.

                  `self-start` on the icon rather than `items-start` on the row
                  for exactly that reason: it changes one child's alignment
                  without contradicting the parent's own `items-center`. */}
              <Link href={meta.newHref} className="gap-3 px-2.5 py-2.5">
                <Icon className="text-muted-foreground mt-0.5 self-start" />
                <span className="space-y-1">
                  <span className="block font-medium">{meta.newLabel}</span>
                  <span className="text-muted-foreground block text-xs leading-relaxed text-pretty">
                    {meta.blurb}
                  </span>
                </span>
              </Link>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
