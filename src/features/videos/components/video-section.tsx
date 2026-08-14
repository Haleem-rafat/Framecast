"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Activity,
  ChevronRight,
  Clapperboard,
  FileText,
  Film,
  MonitorPlay,
  Workflow,
  type LucideIcon,
} from "lucide-react";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

/**
 * The six blocks the video detail page is made of, and the one place their
 * identity is written down.
 *
 * Doubles as the localStorage key, so a typo cannot silently give a section
 * its own private preference slot.
 */
export type VideoSectionKey =
  "pipeline" | "preview" | "script" | "timeline" | "shorts" | "events";

/**
 * Resolved here rather than passed in as a prop, and the reason is a hard
 * boundary rather than a preference: a Lucide icon is a *function*, three of
 * these sections are rendered by the page (a server component), and functions
 * cannot cross the server/client boundary. Passing `icon={Workflow}` type-
 * checks, lints clean, and fails at runtime with "Functions cannot be passed
 * directly to Client Components". Keying off `id` keeps every caller passing
 * nothing but strings.
 */
const SECTION_ICON: Record<VideoSectionKey, LucideIcon> = {
  pipeline: Workflow,
  preview: MonitorPlay,
  script: FileText,
  timeline: Film,
  shorts: Clapperboard,
  events: Activity,
};

/**
 * Where a section's open/closed preference is stored.
 *
 * Keyed by section, deliberately *not* by video: what an operator expresses by
 * folding the log away is "I do not care about logs", not "I do not care about
 * logs on this one video". Keying per video would make the preference
 * unlearnable — every new video would start from the defaults again, so the
 * fold would never save anybody a click on the page they are actually working
 * on. It also means this cannot grow without bound as videos are created.
 */
const STORAGE_PREFIX = "framecast:video-section:";

function storageKeyFor(id: VideoSectionKey): string {
  return `${STORAGE_PREFIX}${id}`;
}

function readStoredOpen(id: VideoSectionKey): boolean | null {
  try {
    const value = window.localStorage.getItem(storageKeyFor(id));
    return value === "1" ? true : value === "0" ? false : null;
  } catch {
    // Private-browsing Safari throws on `localStorage` access rather than
    // returning null. A section that cannot remember its state is a
    // degradation; a page that throws on render is an outage.
    return null;
  }
}

/**
 * Applies the stored open/closed preference to the DOM *while the browser is
 * still parsing this section*, before it has had a chance to paint.
 *
 * This exists because there is no other way to avoid a visible flash. The
 * server has no access to `localStorage`, so it can only render the
 * state-derived default; if the stored preference disagrees, any React-side
 * correction — `useEffect`, `useLayoutEffect`, a store subscription — runs
 * after hydration, which is after the server's markup has already been on
 * screen for a frame or more. An operator who always folds the script away
 * would watch it appear and then vanish on every single page load.
 *
 * An inline script placed immediately after the section's content element runs
 * synchronously during parse, so the correction lands before that content is
 * ever painted. It is the same trick a theme toggle uses to avoid flashing the
 * wrong colour scheme, applied per section rather than to the document.
 *
 * Written as a string rather than a real function passed through `toString()`
 * because the bundler would otherwise be free to rename or transform it. It
 * touches only attributes React re-derives from state a moment later (see
 * `suppressHydrationWarning` below), so at worst a failure here costs a flash,
 * never correctness — hence the blanket try/catch.
 */
const ADOPT_STORED_STATE =
  "function(k,c){try{" +
  'var v=localStorage.getItem(k);if(v!=="0"&&v!=="1")return;' +
  'var open=v==="1";' +
  "var content=document.getElementById(c);if(!content)return;" +
  'if(open){content.removeAttribute("hidden")}else{content.setAttribute("hidden","until-found")}' +
  "var trigger=document.querySelector('[aria-controls=\"'+c+'\"]');" +
  'if(trigger){trigger.setAttribute("aria-expanded",open?"true":"false");' +
  'trigger.setAttribute("data-open",open?"true":"false")}' +
  'var section=content.closest("section");' +
  'if(section){section.setAttribute("data-open",open?"true":"false")}' +
  "}catch(e){}}";

export interface VideoSectionProps {
  /** Which section this is: the localStorage key and the icon, both. */
  id: VideoSectionKey;
  title: string;
  /**
   * The one line that has to answer "do I need to open this?" while the
   * section is shut. A header that only repeats its own title makes folding a
   * cost rather than a saving — the operator has to open every section to find
   * out which one they wanted. Live where the underlying data is live: the
   * pipeline passes a component subscribed to its own poll, not a snapshot.
   */
  summary?: ReactNode;
  /**
   * Whether this section starts open for a video in this state. Set from the
   * page's per-status arrangement so the section an operator came for is
   * already open — folding must never add a click to the common path.
   */
  defaultOpen?: boolean;
  /**
   * True while something inside this section is genuinely changing on its own.
   * Forces the section open and keeps the disclosure control out of the way:
   * an operator who folded the pipeline away and then approved a script should
   * not have to remember to unfold it to watch the render they just started.
   *
   * Only ever *opens*. Falling back to false when a run finishes must not
   * slam the section shut under someone who is reading it.
   */
  active?: boolean;
  /** Extra classes for the body, e.g. the grid a multi-panel section needs. */
  bodyClassName?: string;
  children: ReactNode;
}

/**
 * One collapsible block on the video detail page.
 *
 * The page shows everything about a video at once — pipeline, player, script,
 * timeline, shorts, history — and whichever one an operator opened it for is
 * buried under the ones they did not. Ordering by video status (see the page's
 * `ORDERED_SECTIONS`) solved half of that; folding is the other half.
 *
 * Built directly rather than on `src/components/ui/accordion.tsx`. Radix's
 * accordion owns which item is open through a single `value` on the root,
 * which is the wrong shape for this page three times over: the sections do not
 * share a parent (three of them arrive through their own Suspense boundaries,
 * so there is no one place a root could wrap them all), each needs its *own*
 * default rather than one root-level `defaultValue`, and the "open when this
 * one goes active" rule would mean writing back into the root's controlled
 * value from a child — pushing state up through a component whose only job was
 * to be a layout wrapper. What is left after dropping the root is a disclosure
 * widget, which is a button and a region.
 *
 * The content stays in the DOM whether open or shut. Closed sections use
 * `hidden="until-found"`, so find-in-page still matches inside a folded
 * section and the browser opens it (via `beforematch`) to show the hit;
 * browsers without support treat the unknown value as plain `hidden`, which is
 * the correct fallback rather than a broken one.
 */
export function VideoSection({
  id,
  title,
  summary,
  defaultOpen = false,
  active = false,
  bodyClassName,
  children,
}: VideoSectionProps) {
  const Icon = SECTION_ICON[id];
  const reduced = usePrefersReducedMotion();
  const contentId = `${useId()}-content`;
  const [open, setOpen] = useState(defaultOpen);
  const contentRef = useRef<HTMLDivElement>(null);

  // Adopts whatever the inline script above already applied to the DOM. React
  // still believes the section is in its server-rendered default state, and
  // leaving those two disagreeing would mean the next state change React makes
  // reverts the operator's preference. Nothing paints between the script and
  // this, so this is bookkeeping rather than a second visual change.
  useEffect(() => {
    const stored = readStoredOpen(id);
    if (stored !== null) {
      setOpen(stored);
    }
  }, [id]);

  // A section that starts running while folded opens itself. Guarded on the
  // transition rather than the value so it cannot fight an operator who
  // deliberately folds a long render away while it is still going.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) {
      setOpen(true);
    }
    wasActive.current = active;
  }, [active]);

  // `hidden="until-found"` is not expressible through React's props — its
  // `hidden` is typed (and serialized) as a boolean — so the attribute is
  // upgraded here, after React has rendered the plain boolean form. The
  // boolean is what the server sends, which is what a browser with no
  // JavaScript needs; the upgrade only ever adds find-in-page to it.
  useEffect(() => {
    const element = contentRef.current;
    if (element && !open) {
      element.setAttribute("hidden", "until-found");
    }
  }, [open]);

  // Find-in-page matched inside this folded section, so the browser is about
  // to reveal it. Without this the section would be un-hidden by the browser
  // while React still believed it was shut, and the next render would fold it
  // back over the operator's search hit.
  useEffect(() => {
    const element = contentRef.current;
    if (!element) return;

    const onBeforeMatch = () => setOpen(true);
    element.addEventListener("beforematch", onBeforeMatch);

    return () => element.removeEventListener("beforematch", onBeforeMatch);
  }, []);

  const onToggle = useCallback(() => {
    setOpen((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(storageKeyFor(id), next ? "1" : "0");
      } catch {
        // Storage being unavailable costs the operator a remembered
        // preference, which is not worth failing the click over.
      }
      return next;
    });
  }, [id]);

  return (
    <section
      data-open={open}
      className={cn(
        "group/section bg-card text-card-foreground ring-foreground/10 overflow-hidden rounded-xl ring-1",
        // Entrance, not a scroll reveal. The previous version faded each
        // section in on an IntersectionObserver, which stranded any section
        // the operator scrolled *past* rather than through — jump to the
        // bottom of a finished video and the timeline and shorts sections
        // stayed at `opacity: 0` forever, leaving a measured 1,043px of blank
        // page between the player and the script. An entrance animation has
        // no such failure mode: it runs once from the element's own final
        // state, so a missed frame costs an animation, never the content.
        "animate-in fade-in slide-in-from-bottom-2 duration-500 motion-reduce:animate-none",
      )}
    >
      {/* A heading rather than a bare button: a screen-reader user navigating
          this page by heading gets the same six-item outline of the video that
          a sighted one gets from the folded stack. */}
      <h2>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={contentId}
          data-open={open}
          // The inline script may have already flipped `aria-expanded` and
          // `data-open` on this element before React hydrated it. That is the
          // point of the script, so the mismatch is expected rather than a
          // bug worth reporting — and left unsuppressed React would "repair"
          // it back to the server's default, undoing the very flash this
          // avoids.
          suppressHydrationWarning
          className="hover:bg-accent/40 focus-visible:ring-ring/50 flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors outline-none focus-visible:ring-3 focus-visible:ring-inset"
        >
          <ChevronRight
            aria-hidden="true"
            className="text-muted-foreground size-4 shrink-0 transition-transform duration-200 group-data-[open=true]/section:rotate-90 motion-reduce:transition-none"
          />
          <Icon
            aria-hidden="true"
            className="text-muted-foreground size-4 shrink-0"
          />
          <span className="font-heading text-sm leading-none font-medium">
            {title}
          </span>
          {summary && (
            // Wraps under the title on a narrow phone rather than squeezing
            // the title to two characters; `ml-auto` still right-aligns it
            // whenever both fit on one line.
            <span className="text-muted-foreground ml-auto flex min-w-0 items-center gap-2 text-xs">
              {summary}
            </span>
          )}
        </button>
      </h2>

      {/* Two elements, and the split is load-bearing. `hidden="until-found"`
          is implemented as `content-visibility: hidden`, which — unlike
          `display: none` — still generates a box, so any padding or border on
          the hidden element itself is rendered as empty space. Put the
          section's padding and its divider on this element and every folded
          section would contribute a ~33px strip of nothing: exactly the
          unexplained vertical gap this page was reported for. The outer
          element therefore carries no box of its own. */}
      <div
        ref={contentRef}
        id={contentId}
        hidden={!open}
        suppressHydrationWarning
      >
        <div
          className={cn(
            "border-foreground/10 border-t px-4 py-4",
            // Only the body fades in, and only when it is opened. There is no
            // height animation: the sections on this page contain a video
            // player, a monospace textarea and a scrolling log, all of which
            // report a different height mid-animation than they settle at, so
            // an animated height either jumps at the end or has to be measured
            // every frame. A 150ms fade reads as deliberate and cannot be
            // wrong, and it costs no layout work per frame.
            !reduced && "animate-in fade-in duration-150",
            bodyClassName,
          )}
        >
          {children}
        </div>
      </div>

      {/* Placed after the content so the element it corrects already exists
          when it runs. See ADOPT_STORED_STATE. */}
      <script
        dangerouslySetInnerHTML={{
          __html: `(${ADOPT_STORED_STATE})(${JSON.stringify(storageKeyFor(id))},${JSON.stringify(contentId)})`,
        }}
      />
    </section>
  );
}

/**
 * A single fact in a section header — "486 words", "3 shorts", "9:56".
 *
 * Exists so every summary across six different sections reads as one row of
 * the same thing rather than six panels' worth of separately-invented
 * typography, and so the tone stays neutral: a summary is not a status badge,
 * and colouring one draws the eye to whichever section happened to have a
 * number in it.
 */
export function SectionFact({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("truncate tabular-nums", className)}>{children}</span>
  );
}
