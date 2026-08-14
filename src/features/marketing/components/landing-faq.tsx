import Link from "next/link";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

/**
 * Aceternity's own FAQ block sits behind their paid registry — fetching it
 * returns 401 — so this uses the shadcn Accordion already in the project. That
 * is the better outcome anyway: it is Radix underneath, so the questions are
 * reachable by keyboard and announced correctly, which a hand-rolled disclosure
 * usually is not.
 */
const QUESTIONS = [
  {
    q: "Does it publish without me?",
    a: (
      <>
        No. A run stops twice and waits: once when the script is written, before
        anything that costs money has run, and once when the video is rendered,
        before anything is uploaded. If you do not approve the cut, nothing
        leaves the machine.
      </>
    ),
  },
  {
    q: "What does it ask for on my YouTube account?",
    a: (
      <>
        Permission to read the channel, to upload videos you have approved, and
        to read that channel&apos;s own analytics and estimated revenue so the
        studio can show you how a video did against what it cost. Nothing else —
        it never edits, deletes or comments. The{" "}
        <Link href="/privacy" className="underline underline-offset-4">
          privacy policy
        </Link>{" "}
        lists each permission and why it is requested.
      </>
    ),
  },
  {
    q: "Who pays for the AI?",
    a: (
      <>
        You do, directly to the providers, using the API keys you supply.
        Framecast records what each script, voice and image cost and shows it
        against the video it went into, but it does not cap spending and it
        never bills you itself.
      </>
    ),
  },
  {
    q: "Where does my data live?",
    a: (
      <>
        On one server. The application, the renderer and the PostgreSQL database
        all run on a single machine, and the database accepts no connections
        from the internet. Access tokens and API keys are encrypted at rest
        before they are written.
      </>
    ),
  },
  {
    q: "Can I sign up right now?",
    a: (
      <>
        You can create an account, and an operator reviews it before it can be
        used — Framecast is a private studio tool rather than a public service,
        so accounts are not activated automatically.
      </>
    ),
  },
  {
    q: "Is the footage licensed?",
    a: (
      <>
        Clips come from stock footage providers, matched to the script line by
        line. You remain responsible for what you publish to your own channel,
        including complying with YouTube&apos;s policies — the{" "}
        <Link href="/terms" className="underline underline-offset-4">
          terms
        </Link>{" "}
        set out where that line falls.
      </>
    ),
  },
];

export function LandingFaq() {
  return (
    <section id="faq" className="border-b">
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-6 py-20 sm:py-28 lg:py-36 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-20">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl lg:text-[2.75rem] lg:leading-[1.1]">
            Questions worth asking first
          </h2>
          <p className="text-muted-foreground mt-4 text-base text-pretty sm:text-lg">
            Mostly about control, money and what leaves the machine.
          </p>
        </div>

        <Accordion type="single" collapsible className="w-full">
          {QUESTIONS.map((item) => (
            <AccordionItem key={item.q} value={item.q}>
              <AccordionTrigger className="text-left text-base">
                {item.q}
              </AccordionTrigger>
              <AccordionContent className="text-muted-foreground text-sm text-pretty">
                {item.a}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}
