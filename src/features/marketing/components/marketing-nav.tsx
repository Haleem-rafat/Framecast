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

/**
 * Anchors are root-relative on purpose. This nav is rendered on /privacy,
 * /terms and /contact as well as the landing page, and a bare `#pricing` there
 * scrolls to nothing because the section does not exist on those pages. `/#…`
 * navigates home first, which is what a visitor pressing "Pricing" means.
 */
export const NAV_LINKS = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#features", label: "Features" },
  { href: "/#output", label: "Output" },
  { href: "/#pricing", label: "Pricing" },
  { href: "/#faq", label: "FAQ" },
] as const;

export function MarketingNav() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <nav
        aria-label="Sections"
        className="text-muted-foreground hidden items-center gap-1 text-sm md:flex"
      >
        {NAV_LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="hover:text-foreground hover:bg-accent rounded-md px-2.5 py-1.5 transition-colors lg:px-3"
          >
            {link.label}
          </Link>
        ))}
      </nav>

      {/* Below md the links move into a sheet rather than disappearing: an
          empty bar on a phone is the same problem as an empty bar on a
          desktop. */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
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

            <hr className="my-3" />

            <SheetClose asChild>
              <Link
                href="/contact"
                className="hover:bg-accent rounded-md px-2 py-2.5 text-sm transition-colors"
              >
                Contact
              </Link>
            </SheetClose>

            <SheetClose asChild>
              <Button asChild className="mt-3">
                <Link href="/sign-up">Create an account</Link>
              </Button>
            </SheetClose>
            <SheetClose asChild>
              <Button asChild variant="outline">
                <Link href="/sign-in">Sign in</Link>
              </Button>
            </SheetClose>
          </nav>
        </SheetContent>
      </Sheet>
    </>
  );
}
