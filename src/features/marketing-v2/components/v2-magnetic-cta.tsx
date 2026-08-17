"use client";

import Link from "next/link";

import Magnet from "@/components/react-bits/Magnet";
import StarBorder from "@/components/react-bits/StarBorder";
import { Button } from "@/components/ui/button";

/**
 * The last ask on the page.
 *
 * Two React Bits pieces stacked, and this is the only place both appear
 * together: StarBorder puts the same travelling light round it that the hero's
 * primary action has, and Magnet leans it towards the pointer. The page now
 * has exactly three of these buttons — hero, pricing, here — and they are the
 * three places it asks for the same thing.
 *
 * `magnetStrength={6}` is a much weaker pull than the library's default of 2
 * (the number divides the offset, so larger is gentler). A button that leaps
 * at the cursor is a button people miss; this one shifts a few pixels, which
 * reads as responsiveness rather than as a game.
 *
 * The vendored Magnet is inert under `prefers-reduced-motion` and on any
 * coarse pointer, so the target never moves for a thumb or for anyone who
 * asked for less movement.
 */
export function V2MagneticCta() {
  return (
    <Magnet padding={70} magnetStrength={6}>
      <StarBorder
        color="var(--brand-violet)"
        speed="5s"
        thickness={2}
        contentClassName="p-[2px]"
      >
        <Button asChild size="lg" className="rounded-full px-5">
          <Link href="/sign-up">Create an account</Link>
        </Button>
      </StarBorder>
    </Magnet>
  );
}
