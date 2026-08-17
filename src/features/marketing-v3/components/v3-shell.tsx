import Link from "next/link";

import { V3Nav } from "@/features/marketing-v3/components/v3-nav";

/**
 * v3's shell.
 *
 * The chrome is the scroll-contracting bar in `v3-nav.tsx`; everything else
 * here is the same `marketing` class boundary v1 and v2 use, which is what
 * switches the whole CSS-variable palette from the studio's chroma-0 neutrals
 * to the colour grade in globals.css. Set here and nowhere else, so nothing
 * under /dashboard changes.
 *
 * `overflow-x-clip` rather than `hidden`: several React Bits components on
 * this page position themselves deliberately outside their parent's box, and
 * `clip` contains that without making this element a scroll container, which
 * would break the `position: sticky` that ScrollExpand and the FAQ rail rely
 * on.
 */
export function V3Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="marketing bg-background text-foreground min-h-svh overflow-x-clip">
      <V3Nav />

      <main>{children}</main>

      <footer className="border-t">
        <div className="text-muted-foreground mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-8 text-xs">
          <span>
            © {new Date().getFullYear()} Framecast · compare with{" "}
            <Link href="/" className="hover:text-foreground underline underline-offset-4">
              v1
            </Link>{" "}
            and{" "}
            <Link href="/v2" className="hover:text-foreground underline underline-offset-4">
              v2
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
