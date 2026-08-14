"use client";

import Link from "next/link";
import { useState } from "react";
import { Menu } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/**
 * Anchors are root-relative on purpose. This nav is rendered on /privacy,
 * /terms and /contact as well as the landing page, and a bare `#pricing` there
 * scrolls to nothing because the section does not exist on those pages. `/#…`
 * navigates home first, which is what a visitor pressing "Pricing" means.
 *
 * Every href here has a matching `id` on a section of `src/app/page.tsx`. If you
 * add one, add the id too — a nav link that scrolls nowhere is worse than no
 * link, because the visitor concludes the page is broken rather than short.
 *
 * The smooth scroll itself is CSS (`scroll-behavior` in globals.css) rather than
 * a JavaScript handler, which means it costs nothing, survives a middle-click
 * into a new tab, and is already gated behind `prefers-reduced-motion` there.
 */
export const NAV_LINKS = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#features", label: "Features" },
  { href: "/#pricing", label: "Pricing" },
  { href: "/#faq", label: "FAQ" },
] as const;

/** The horizontal list, for viewports wide enough to hold it. */
export function MarketingNavLinks({ className }: { className?: string }) {
  return (
    <nav
      aria-label="Sections"
      className={cn(
        "text-muted-foreground hidden items-center gap-0.5 text-sm md:flex",
        className,
      )}
    >
      {NAV_LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="hover:text-foreground hover:bg-accent rounded-md px-2.5 py-1.5 whitespace-nowrap transition-colors lg:px-3"
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * The same links below `md`, in a sheet. They move rather than disappear: a
 * phone getting the identical empty bar the desktop had is the bug, not the
 * fix. The two account buttons hide below `sm` in the header and reappear at
 * the bottom of this panel, so a 375px bar is only ever the wordmark, the
 * theme toggle and this button.
 */
export function MarketingNavSheet({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn("md:hidden", className)}
          aria-label="Open menu"
        >
          <Menu className="size-4" />
        </Button>
      </SheetTrigger>

      <SheetContent side="right" className="w-72">
        <SheetHeader>
          <SheetTitle>Framecast</SheetTitle>
        </SheetHeader>

        <nav aria-label="Sections" className="flex flex-col gap-1 px-4">
          {NAV_LINKS.map((link) => (
            <SheetClose asChild key={link.href}>
              <Link
                href={link.href}
                className="hover:bg-accent rounded-md px-2 py-2.5 text-sm transition-colors"
              >
                {link.label}
              </Link>
            </SheetClose>
          ))}

          <SheetClose asChild>
            <Link
              href="/contact"
              className="hover:bg-accent rounded-md px-2 py-2.5 text-sm transition-colors"
            >
              Contact
            </Link>
          </SheetClose>

          <hr className="my-3" />

          <SheetClose asChild>
            <Button asChild>
              <Link href="/sign-up">Create an account</Link>
            </Button>
          </SheetClose>
          <SheetClose asChild>
            <Button asChild variant="outline" className="mt-2">
              <Link href="/sign-in">Sign in</Link>
            </Button>
          </SheetClose>
        </nav>
      </SheetContent>
    </Sheet>
  );
}
