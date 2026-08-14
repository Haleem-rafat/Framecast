import { DeviceScroll } from "@/components/ui/device-scroll";

/**
 * The section immediately above this one claims the pipeline stops and waits
 * for a person. This is that claim with the receipt attached: a real capture of
 * the studio, on a real draft, with the button that unblocks it.
 *
 * It is placed here deliberately — a promise and its evidence should not be
 * separated by four sections of other material.
 *
 * The image is a genuine screenshot from a running instance, which is why the
 * caption says so out loud. Everywhere else on this page the artwork is drawn
 * in CSS and labelled "Illustrations, not screenshots"; being equally explicit
 * in the one place there *is* a screenshot is what makes that other label worth
 * anything.
 */
export function LandingApproval() {
  return (
    <section
      id="approval"
      className="relative isolate overflow-hidden border-b"
    >
      {/* Static wash. The lid is the only moving thing in this section. */}
      <div
        aria-hidden="true"
        className="from-brand-violet/10 via-brand-blue/5 absolute inset-0 -z-10 bg-gradient-to-b to-transparent"
      />

      <div className="mx-auto w-full max-w-6xl px-6 py-20 sm:py-28 lg:py-32">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-muted-foreground font-mono text-[11px] tracking-[0.18em] uppercase">
            Gate one, in the actual product
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl lg:text-[2.75rem] lg:leading-[1.1]">
            The script lands here, and stops
          </h2>
          <p className="text-muted-foreground mt-4 text-base text-pretty sm:text-lg">
            A draft video, the script the model wrote, every version it has been
            through, and one button. Until that button is pressed nothing is
            narrated, nothing is rendered and nothing is paid for.
          </p>
        </div>

        <div className="mt-14 sm:mt-16">
          <DeviceScroll
            src="/marketing/studio-video-detail.png"
            alt="The Framecast studio on a draft video: the generated script in an editor, a version history beside it, and an Approve script button in the header."
            width={2880}
            height={1800}
            caption={
              <p className="text-muted-foreground mx-auto mt-8 max-w-xl text-center text-xs text-pretty">
                A real screenshot of the studio, not a mock-up. The video in it
                is a seeded example rather than anyone&apos;s channel.
              </p>
            }
          />
        </div>
      </div>
    </section>
  );
}
