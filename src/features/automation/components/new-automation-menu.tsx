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
      <DropdownMenuContent align="end" className="max-w-xs">
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
                  happened to emit last would win. */}
              <Link href={meta.newHref} className="gap-3 py-1.5">
                <Icon />
                <span className="space-y-0.5">
                  <span className="block font-medium">{meta.newLabel}</span>
                  <span className="text-muted-foreground block text-xs text-wrap">
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
