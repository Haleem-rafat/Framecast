"use client";

import Link from "next/link";
import { useState } from "react";
import { Menu } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useMarketingAccount } from "@/features/marketing/components/marketing-account";
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
 * What is left of the mobile menu once the floating dock has the sections.
 *
 * They used to be listed here too, and behind a tap in the top-right corner of
 * a phone was the wrong place for them: the sections are how the page is read,
 * they are wanted constantly, and they are the one thing a bar can show the
 * current position in. So they moved to `MarketingDock` and this panel keeps
 * what a five-slot dock has no room for and nobody needs mid-scroll — contact,
 * and the two account buttons that hide from the header below `sm`.
 *
 * The remaining row is 44px rather than the links' 36px: this is a panel
 * operated by a thumb.
 */
export function MarketingNavSheet({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const { user } = useMarketingAccount();

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

        {/* Not "Sections": that name belongs to the header nav and now to the
            dock, and three navigations answering to one label is how a screen
            reader user ends up unable to tell them apart. */}
        <nav aria-label="Account" className="flex flex-col gap-1 px-4">
          <SheetClose asChild>
            <Link
              href="/contact"
              className="hover:bg-accent flex h-11 items-center rounded-md px-2 text-sm transition-colors"
            >
              Contact
            </Link>
          </SheetClose>

          <hr className="my-3" />

          {/* The same swap the header makes, for the same reason and resolved
              the same way while the session is still unknown — see the comment
              beside it in marketing-header.tsx. Both have to agree: this sheet
              *is* the header below `md`, and a bar offering the studio over a
              drawer offering sign-up would be one component contradicting
              itself at a breakpoint. */}
          {user ? (
            <SheetClose asChild>
              <Button asChild>
                <Link href="/dashboard">Go to your dashboard</Link>
              </Button>
            </SheetClose>
          ) : (
            <>
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
            </>
          )}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
