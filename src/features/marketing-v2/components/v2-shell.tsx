import Link from "next/link";

import { V2Lead } from "@/features/marketing-v2/components/v2-lead";
import { MarketingNavBar } from "@/features/marketing-v2/components/v2-nav";

/**
 * v2's chrome, and it is not v1's.
 *
 * v1 wears a full-width sticky bar with a hairline under it, a footer, and a
 * floating dock on phones — a website's chrome. v2 floats a single glass pill
 * over a page that runs edge to edge underneath it, because the layout below
 * has no repeating section frame for a bar to sit on top of. The page is one
 * continuous surface with bands of different weight, not a stack of bordered
 * boxes.
 *
 * The anchors are `/v2#…`, not `/#…`. v1's nav is root-relative because it
 * also renders on /privacy and /terms, where a bare `#pricing` scrolls
 * nowhere; here those same hrefs would navigate the visitor off the page they
 * are reading.
 *
 * `MarketingNavSheet` and `MarketingThemeToggle` are imported from v1 rather
 * than copied. Neither contains a section anchor, so both work unchanged, and
 * neither file is modified.
 */


export function V2Shell({ children }: { children: React.ReactNode }) {
  return (
    // `overflow-x-clip` rather than `hidden`: several React Bits components on
    // this page — CardSwap most of all — position themselves deliberately
    // outside their parent's box, and `clip` contains that without making this
    // element a scroll container, which would break the `position: sticky`
    // used further down the page.
    <div className="marketing bg-background text-foreground min-h-svh overflow-x-clip">
      <MarketingNavBar basePath="/v2" />

      <main>{children}</main>

      <footer className="border-t">
        <div className="text-muted-foreground mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-8 text-xs">
          <span>
            © {new Date().getFullYear()} Framecast ·{" "}
            <Link
              href="/"
              className="hover:text-foreground underline underline-offset-4"
            >
              compare with v1
            </Link>
          </span>
          <nav className="flex gap-4">
            <Link href="/privacy" className="hover:text-foreground transition-colors">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-foreground transition-colors">
              Terms
            </Link>
            <Link href="/contact" className="hover:text-foreground transition-colors">
              Contact
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}

/**
 * The band heading used across v2.
 *
 * Different shape from v1's, on purpose: v1 heads every section with a large
 * left-aligned title and a supporting paragraph in a 2xl measure. Here the
 * eyebrow sits on a rule, the title is tighter, and the supporting line is
 * optional — the bands below carry more of their meaning in the layout than
 * in prose.
 *
 * The emphasised words use the `-ink` gradient stops, never the decorative
 * ones. `bg-clip-text` makes the gradient the text's actual colour, and the
 * decorative cyan measures 2.18:1 on the light ground, under even the 3:1
 * floor large text gets.
 */
export function V2BandHeading({
  eyebrow,
  title,
  accent,
  children,
  align = "left",
  reveal = false,
}: {
  eyebrow: string;
  title: string;
  accent?: string;
  children?: React.ReactNode;
  align?: "left" | "center";
  /**
   * Un-blur the supporting line word by word as the band scrolls up. Only for
   * bands whose opening line is a claim rather than a label, and only where
   * `children` is a plain string — see `V2Lead`.
   */
  reveal?: boolean;
}) {
  return (
    <div className={align === "center" ? "mx-auto max-w-2xl text-center" : "max-w-2xl"}>
      <div
        className={`flex items-center gap-3 ${align === "center" ? "justify-center" : ""}`}
      >
        <span
          aria-hidden="true"
          className="from-brand-violet-ink to-brand-cyan-ink h-px w-8 bg-gradient-to-r"
        />
        <p className="text-muted-foreground font-mono text-[11px] tracking-[0.2em] uppercase">
          {eyebrow}
        </p>
      </div>

      <h2 className="mt-4 text-[1.75rem] leading-[1.12] font-semibold tracking-tight text-balance sm:text-4xl lg:text-[2.75rem]">
        {title}
        {accent ? (
          <>
            {" "}
            <span className="from-brand-violet-ink via-brand-blue-ink to-brand-cyan-ink bg-gradient-to-r bg-clip-text text-transparent">
              {accent}
            </span>
          </>
        ) : null}
      </h2>

      {children ? (
        reveal && typeof children === "string" ? (
          <V2Lead>{children}</V2Lead>
        ) : (
          <p className="text-muted-foreground mt-4 text-base text-pretty sm:text-lg">
            {children}
          </p>
        )
      ) : null}
    </div>
  );
}
