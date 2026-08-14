import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Spotlight } from "@/components/ui/spotlight-new";

/**
 * Deliberately a server component that happens to render one client component.
 * The headline, the sentence under it and both calls to action are in the
 * initial HTML with no JavaScript involved — the spotlight is the only part
 * that hydrates, and if it never does the hero still reads correctly.
 */
export function LandingHero() {
  return (
    <section className="relative isolate overflow-hidden border-b">
      <Spotlight />

      {/* Centred, because the two beams come in symmetrically from the top
          corners: anything ranged left sits off the light. */}
      <div className="relative mx-auto flex w-full max-w-3xl flex-col items-center px-6 py-20 text-center sm:py-28 lg:py-32">
        <p className="text-muted-foreground inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs">
          <span className="bg-primary size-1.5 rounded-full" />
          Self-hosted. One topic in, one published video out.
        </p>

        <h1 className="mt-6 text-[2.1rem] leading-[1.08] font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">
          Turn a topic into a finished YouTube video.
        </h1>

        <p className="text-muted-foreground mt-6 max-w-2xl text-base text-pretty sm:text-lg">
          Framecast writes a sourced script, narrates it, matches footage to
          every line, renders it with burned-in captions, music and motion, then
          publishes it to your channel. You approve the script before it spends
          anything, and the finished cut before anyone else sees it.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button asChild size="lg">
            <Link href="/sign-up">Create an account</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/sign-in">Sign in</Link>
          </Button>
        </div>

        <p className="text-muted-foreground mt-5 max-w-md text-xs text-pretty">
          Framecast is under active development. Every account is reviewed by an
          operator before it can be used.
        </p>
      </div>
    </section>
  );
}
