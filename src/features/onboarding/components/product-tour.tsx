"use client";

import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { TOUR_STEPS, type TourStep } from "@/features/onboarding/tour-steps";

/**
 * Marks the tour as seen. A UI preference, not domain state: it belongs to this
 * browser, needs no history, and nothing server-side ever asks about it — so it
 * lives in localStorage rather than costing a column and a migration. The cost
 * of being wrong is that someone sees the tour twice on a second device.
 */
const SEEN_KEY = "framecast:tour-seen:v1";

/** Breathing room between the highlighted element and the cutout's edge. */
const SPOTLIGHT_PADDING = 6;
/** Gap between the cutout and the card that explains it. */
const CARD_GAP = 12;
const CARD_WIDTH = 340;
/** Below this the sidebar is a drawer, so its items aren't on screen to point
 *  at. The tour would be pointing at nothing, so it doesn't run at all. */
const MIN_VIEWPORT_WIDTH = 768;

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function rectOf(target: string): Rect | null {
  const element = document.querySelector(`[data-tour="${target}"]`);

  if (!element) {
    return null;
  }

  const { top, left, width, height } = element.getBoundingClientRect();

  // A zero-sized box means the element is in the DOM but not rendered — a
  // collapsed sidebar, a hidden panel. Pointing at it would put the card in a
  // corner with nothing under it.
  if (width === 0 || height === 0) {
    return null;
  }

  return { top, left, width, height };
}

/**
 * Places the card beside the cutout, preferring the right — the sidebar is on
 * the left, so most targets have room there — and flipping when it would leave
 * the viewport. Clamped on both axes so the card is never partly off screen,
 * whatever the target's position.
 */
function placeCard(rect: Rect, viewport: { width: number; height: number }) {
  const wouldOverflowRight = rect.left + rect.width + CARD_GAP + CARD_WIDTH > viewport.width;

  const left = wouldOverflowRight
    ? Math.max(CARD_GAP, rect.left - CARD_GAP - CARD_WIDTH)
    : rect.left + rect.width + CARD_GAP;

  // Roughly vertically centred on the target, then clamped. The card's real
  // height isn't known before paint, so this reserves a conservative 220px.
  const top = Math.min(
    Math.max(CARD_GAP, rect.top + rect.height / 2 - 110),
    Math.max(CARD_GAP, viewport.height - 220 - CARD_GAP),
  );

  return { top, left };
}

export function ProductTour({ autoStart }: { autoStart: boolean }) {
  const [steps, setSteps] = useState<TourStep[] | null>(null);
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);

  const finish = useCallback(() => {
    window.localStorage.setItem(SEEN_KEY, "1");
    setSteps(null);
  }, []);

  // Deciding what to run has to happen on the client: it depends on
  // localStorage and on which targets actually rendered, neither of which the
  // server knows. Running it in an effect also keeps the first paint identical
  // between server and client, so there's no hydration mismatch.
  useEffect(() => {
    if (!autoStart || window.localStorage.getItem(SEEN_KEY) === "1") {
      return;
    }

    if (window.innerWidth < MIN_VIEWPORT_WIDTH) {
      return;
    }

    const present = TOUR_STEPS.filter((step) => rectOf(step.target) !== null);

    // One lonely step isn't a tour. Better to show nothing than to interrupt
    // someone with a single popover.
    if (present.length < 2) {
      return;
    }

    setSteps(present);
  }, [autoStart]);

  const current = steps?.[index] ?? null;

  // Measured before paint, so the spotlight never appears at a stale position
  // for a frame when moving between steps.
  useLayoutEffect(() => {
    if (!current) {
      return;
    }

    const measure = () => setRect(rectOf(current.target));
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
    if (!current) {
      return;
    }

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
        className="pointer-events-none absolute rounded-lg ring-2 ring-background/80 transition-all duration-200"
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
       * Dismissal by keyboard is unaffected: Escape is bound above and the X
       * button is properly focusable. */}
      <div
        aria-hidden="true"
        onClick={finish}
        className="absolute inset-0 cursor-default"
      />

      <div
        className="bg-popover text-popover-foreground absolute flex flex-col gap-3 rounded-xl p-5 shadow-2xl shadow-black/30 ring-1 ring-foreground/10 transition-all duration-200"
        style={{ top: card.top, left: card.left, width: CARD_WIDTH }}
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

        <p className="text-muted-foreground text-sm leading-relaxed">{current.body}</p>

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
