"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { TOUR_KEY } from "@/features/onboarding/dismissal";
import { useOnboarding } from "@/features/onboarding/components/onboarding-provider";
import { TOUR_STEPS, type TourStep } from "@/features/onboarding/tour-steps";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";

/** Breathing room between the highlighted element and the cutout's edge. */
const SPOTLIGHT_PADDING = 6;
/** Gap between the cutout and the card that explains it. */
const CARD_GAP = 12;
const CARD_WIDTH = 340;
/**
 * Below this there is no room to put a 340px card *beside* anything, so the
 * card goes above or below the target instead and spans the screen.
 *
 * This used to be `MIN_VIEWPORT_WIDTH`, and the tour refused to run at all
 * under it. That was defensible only because every step but two pointed at a
 * sidebar row, and the sidebar does not render below `md` — so the tour would
 * have been narrating an empty left margin. The steps now point at the page and
 * the top bar, both of which exist at every width, and the dock stands in for
 * the sidebar. There is nothing left to bail out for, and bailing out meant no
 * first-run experience at all on a phone.
 */
const NARROW_VIEWPORT = 640;
/** Margin from the screen edge for the full-width card on a narrow viewport. */
const EDGE_MARGIN = 12;
/**
 * Space to assume the card needs when deciding which side of the target it goes
 * on. Its real height is not known until it has rendered, and anchoring by the
 * near edge (`top` below the target, `bottom` above it) means an under-estimate
 * costs nothing — the card grows away from the thing it is pointing at.
 */
const ASSUMED_CARD_HEIGHT = 220;

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * The first *rendered* element carrying this target, not the first in the DOM.
 *
 * `tour-nav` is on the sidebar and on the mobile dock, exactly one of which is
 * ever displayed. A bare `querySelector` returns the sidebar every time, and on
 * a phone the sidebar is a closed drawer — so the tour would point at a
 * zero-sized box and skip its own navigation step on the one device where
 * navigation most needs explaining.
 */
function elementFor(target: string): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>(
    `[data-tour="${target}"]`,
  );

  for (const candidate of candidates) {
    const { width, height } = candidate.getBoundingClientRect();
    // A zero-sized box means the element is in the DOM but not rendered — a
    // collapsed sidebar, a hidden panel, a `md:hidden` dock on a desktop.
    if (width > 0 && height > 0) return candidate;
  }

  return null;
}

interface CardPosition {
  left: number;
  width: number;
  /** Exactly one of these is set — see `ASSUMED_CARD_HEIGHT`. */
  top?: number;
  bottom?: number;
}

/**
 * Beside the target on a desktop, above or below it on a phone.
 *
 * The wide branch prefers the right, because the sidebar is on the left and
 * most targets have room there, and flips when the card would leave the
 * viewport. The narrow branch has no sideways room at all, so it goes below the
 * target when there is space beneath and above it otherwise — anchored by
 * whichever edge faces the target, so the card can be any height without ever
 * covering the thing it is describing.
 */
function placeCard(
  rect: Rect,
  viewport: { width: number; height: number },
): CardPosition {
  if (viewport.width < NARROW_VIEWPORT) {
    const width = viewport.width - EDGE_MARGIN * 2;
    const below = rect.top + rect.height + CARD_GAP;
    const fitsBelow = below + ASSUMED_CARD_HEIGHT <= viewport.height;

    return fitsBelow
      ? { left: EDGE_MARGIN, width, top: below }
      : {
          left: EDGE_MARGIN,
          width,
          bottom: Math.max(EDGE_MARGIN, viewport.height - rect.top + CARD_GAP),
        };
  }

  const wouldOverflowRight =
    rect.left + rect.width + CARD_GAP + CARD_WIDTH > viewport.width;

  const left = wouldOverflowRight
    ? Math.max(CARD_GAP, rect.left - CARD_GAP - CARD_WIDTH)
    : rect.left + rect.width + CARD_GAP;

  // Roughly vertically centred on the target, then clamped.
  const top = Math.min(
    Math.max(CARD_GAP, rect.top + rect.height / 2 - ASSUMED_CARD_HEIGHT / 2),
    Math.max(CARD_GAP, viewport.height - ASSUMED_CARD_HEIGHT - CARD_GAP),
  );

  return { left, width: CARD_WIDTH, top };
}

/**
 * The first-run walkthrough. Five steps, ending at the operator's first video.
 *
 * `autoStart` is the dashboard's judgement about whether this account still
 * needs it; `tourRequested` is the operator asking for it back from /settings
 * or the ⌘K palette, and outranks having finished it before. Whether it has
 * been seen lives on the user row rather than in this browser — see
 * `UserSetting.onboardingSeen` — so an operator who learned the app on a laptop
 * is not taught it again on their phone.
 */
export function ProductTour({ autoStart }: { autoStart: boolean }) {
  const { isDismissed, dismiss, tourRequested, clearTourRequest } =
    useOnboarding();
  const reducedMotion = usePrefersReducedMotion();

  const [steps, setSteps] = useState<TourStep[] | null>(null);
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const wanted = tourRequested || (autoStart && !isDismissed(TOUR_KEY));

  const finish = useCallback(() => {
    setSteps(null);
    setIndex(0);
    clearTourRequest();
    dismiss(TOUR_KEY);
  }, [clearTourRequest, dismiss]);

  // Which steps can actually run has to be decided in the browser: it depends
  // on which targets rendered, which the server does not know. Doing it in an
  // effect also keeps the first paint identical on both sides, so there is no
  // hydration mismatch.
  useEffect(() => {
    if (!wanted) {
      setSteps(null);
      return;
    }

    const present = TOUR_STEPS.filter((step) => elementFor(step.target) !== null);

    // One lonely step isn't a tour. Better to show nothing than to interrupt
    // someone with a single popover — and if this ever fires it means the
    // targets have drifted, which `tour-steps.test.ts` is there to catch first.
    if (present.length < 2) {
      clearTourRequest();
      return;
    }

    setIndex(0);
    setSteps(present);
  }, [wanted, clearTourRequest]);

  const current = steps?.[index] ?? null;

  // Measured before paint, so the spotlight never appears at a stale position
  // for a frame when moving between steps.
  useLayoutEffect(() => {
    if (!current) return;

    const measure = () => {
      const element = elementFor(current.target);
      if (!element) {
        setRect(null);
        return;
      }

      const box = element.getBoundingClientRect();
      // A target below the fold — the checklist on a phone, say — would
      // otherwise be spotlit off screen with the card floating over nothing.
      // Instant rather than smooth on purpose: the measurement below has to
      // describe where the element *is*, and a smooth scroll would make that
      // true only several frames later.
      if (box.top < 0 || box.bottom > window.innerHeight) {
        element.scrollIntoView({ block: "center", behavior: "auto" });
      }

      const { top, left, width, height } = element.getBoundingClientRect();
      setRect(width > 0 && height > 0 ? { top, left, width, height } : null);
    };

    measure();

    window.addEventListener("resize", measure);
    // Capture phase: scrolling happens inside the main panel, not on window,
    // and a scroll event on an inner element doesn't bubble up here otherwise.
    window.addEventListener("scroll", measure, true);

    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [current]);

  // Focus follows the step. Without this, tabbing from the page behind the
  // overlay walks the whole dimmed studio before reaching the one dialog that
  // is actually operable — and a keyboard user who pressed nothing has no idea
  // the tour has moved on.
  useEffect(() => {
    if (current) cardRef.current?.focus();
  }, [current]);

  const isLast = steps !== null && index === steps.length - 1;

  const next = useCallback(() => {
    if (isLast) {
      finish();
    } else {
      setIndex((i) => i + 1);
    }
  }, [isLast, finish]);

  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  useEffect(() => {
    if (!current) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        finish();
        return;
      }
      // Arrow keys only. `Enter` used to be handled here too, but this listener
      // is on `window`: with focus on the tour's own Next button — where a
      // keyboard user's focus naturally is — one press fired both the button's
      // onClick and this handler, skipping a step every time. Enter is already
      // the activation key for whatever is focused, so it never needed a
      // global binding.
      if (event.key === "ArrowRight") next();
      if (event.key === "ArrowLeft") back();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [current, finish, next, back]);

  // `steps` is checked alongside `current` even though a non-null `current`
  // implies it — the compiler can't follow that through the optional index, and
  // the step counter below reads `steps.length`.
  if (!steps || !current || !rect || typeof document === "undefined") {
    return null;
  }

  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const card = placeCard(rect, viewport);
  // The spotlight and the card slide between steps. For somebody who asked
  // their system for less motion they jump instead, which is the same
  // information with none of the travel.
  const motion = reducedMotion ? "" : "transition-all duration-200";

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="tour-title"
      className="fixed inset-0 z-[100]"
    >
      {/* The dim and the cutout are one element: a huge spread box-shadow
       * darkens everything outside this box, so the highlighted element stays
       * at full brightness without a second overlay or a clip-path. */}
      <div
        className={`pointer-events-none absolute rounded-lg ring-2 ring-background/80 ${motion}`}
        style={{
          top: rect.top - SPOTLIGHT_PADDING,
          left: rect.left - SPOTLIGHT_PADDING,
          width: rect.width + SPOTLIGHT_PADDING * 2,
          height: rect.height + SPOTLIGHT_PADDING * 2,
          boxShadow: "0 0 0 9999px rgba(0,0,0,0.62)",
        }}
      />

      {/* Sits above the dim and swallows clicks, so the tour is modal without
       * a separate full-screen overlay competing with the cutout.
       *
       * A `<div>`, not the `<button>` this used to be. As a button it was the
       * first tabbable element inside the dialog — so tabbing in landed on an
       * invisible, viewport-sized control announcing "Skip the tour", the exact
       * name of the real X button a few stops later. Two identically named
       * controls, one of them nine tenths of the screen and invisible, is a
       * worse outcome than the click-to-dismiss affordance it was buying.
       * Dismissal by keyboard is unaffected: Escape is bound above, the card
       * itself takes focus on every step, and the X button is focusable. */}
      <div
        aria-hidden="true"
        onClick={finish}
        className="absolute inset-0 cursor-default"
      />

      <div
        ref={cardRef}
        // Focusable by script but not in the tab order: focus is moved here on
        // every step so the next Tab lands on Back or Next, not on the page
        // behind the dim.
        tabIndex={-1}
        className={`bg-popover text-popover-foreground absolute flex flex-col gap-3 rounded-xl p-5 shadow-2xl shadow-black/30 ring-1 ring-foreground/10 outline-none ${motion}`}
        style={{
          top: card.top,
          bottom: card.bottom,
          left: card.left,
          width: card.width,
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="tour-title" className="text-base leading-tight font-semibold tracking-tight">
            {current.title}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground -mt-1 -mr-1 size-7 shrink-0"
            onClick={finish}
            aria-label="Skip the tour"
          >
            <X />
          </Button>
        </div>

        <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
          {current.body}
        </p>

        <div className="flex items-center justify-between gap-3 pt-1">
          {/* Advancing swaps the title and body in place, which a screen
            * reader has no reason to re-read. This counter is the one element
            * guaranteed to change on every step, so making it the live region
            * is what announces that anything happened at all. */}
          <span
            role="status"
            aria-live="polite"
            className="text-muted-foreground text-xs tabular-nums"
          >
            Step {index + 1} of {steps.length}
          </span>

          <div className="flex items-center gap-2">
            {index > 0 && (
              <Button variant="ghost" size="sm" onClick={back}>
                <ArrowLeft />
                Back
              </Button>
            )}
            <Button size="sm" onClick={next}>
              {isLast ? "Get started" : "Next"}
              {!isLast && <ArrowRight />}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
