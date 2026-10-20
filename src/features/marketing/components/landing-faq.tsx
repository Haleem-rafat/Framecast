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
        Not unless you tell it to. A video you make stops twice and waits: once
        when the script is written, before a credit is spent, and once when the
        video is rendered, before anything is uploaded. Automation (series and
        schedules) approves its own scripts so it can run while you are away,
        and it uploads on its own only if you switch on auto-publish for it.
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
        Your plan does. The AI that writes, narrates and illustrates your
        videos is included: you spend credits, one for a Short and five for a
        long video, and there are no provider accounts or API keys to set up.
        A video that fails to render gives its credits back.
      </>
    ),
  },
  {
    q: "Where does my data live?",
    a: (
      <>
        On Framecast Studio&apos;s own server. The database accepts no
        connections from the internet, and YouTube access tokens are encrypted
        before they are stored. Payments are handled by Paddle; card details
        never reach us.
      </>
    ),
  },
  {
    q: "Can I sign up right now?",
    a: (
      <>
        Yes. Create an account and it starts on the free trial with 3 credits,
        enough to make your first videos. No card is needed for the trial.
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
