"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  dismissOnboardingAction,
  restoreOnboardingAction,
} from "@/actions/onboarding.action";
import {
  withDismissed,
  withHelpHintsRestored,
  withRestored,
} from "@/features/onboarding/dismissal";

interface OnboardingContextValue {
  isDismissed(key: string): boolean;
  /** Hides now, records it in the background. */
  dismiss(key: string): void;
  /** Puts specific keys back. */
  restore(keys: readonly string[]): void;
  /** Puts every screen note back, leaving the tour and checklist alone. */
  restoreHelpHints(): void;
  /** Puts everything back, including the tour and the checklist. */
  restoreEverything(): void;
  /** True while a replay has been asked for and not yet finished. */
  tourRequested: boolean;
  /** Replays the tour, from wherever the operator asked for it. */
  requestTour(): void;
  clearTourRequest(): void;
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

/**
 * Where /dashboard is, and therefore where the tour is. Every target the tour
 * points at is either on that page or in the top bar above it, so asking for a
 * replay from /settings has to take the operator there first.
 */
const TOUR_HOME = "/dashboard";

/**
 * Holds what the operator has already read, for every onboarding surface at
 * once.
 *
 * Mounted by the dashboard layout, so the tour on /dashboard, the note at the
 * top of whatever screen you are on, and the palette command that brings them
 * back are all looking at the same set — and so that set survives client-side
 * navigation instead of being re-fetched per page.
 *
 * ## Optimistic, and why that is the right way round here
 *
 * Every mutation updates local state first and posts afterwards, ignoring the
 * result. The action being performed is "stop showing me this", and the worst
 * case of a lost write is that the same note appears once more on the next
 * hard load. Making the operator watch a spinner to dismiss a tip — or, worse,
 * leaving the tip on screen until a round trip lands — would be a strictly
 * worse product for a strictly less likely failure.
 *
 * `dismissed` is seeded from the server on first render, which is what stops a
 * hint from flashing up and then withdrawing itself: by the time the layout
 * renders, the page already knows the answer.
 */
export function OnboardingProvider({
  dismissed: initial,
  children,
}: {
  dismissed: string[];
  children: ReactNode;
}) {
  const router = useRouter();
  const [dismissed, setDismissed] = useState<string[]>(initial);
  const [tourRequested, setTourRequested] = useState(false);

  const dismiss = useCallback((key: string) => {
    setDismissed((current) => withDismissed(current, key));
    void dismissOnboardingAction({ key });
  }, []);

  const restore = useCallback((keys: readonly string[]) => {
    setDismissed((current) => withRestored(current, keys));
    void restoreOnboardingAction({ keys: [...keys] });
  }, []);

  const restoreHelpHints = useCallback(() => {
    // Computed from the current set rather than sent as "clear the prefix",
    // so the server action keeps one narrow shape — remove these exact keys —
    // and cannot be talked into clearing more than the caller could name.
    setDismissed((current) => {
      const next = withHelpHintsRestored(current);
      const removed = current.filter((key) => !next.includes(key));
      if (removed.length > 0) void restoreOnboardingAction({ keys: removed });
      return next;
    });
  }, []);

  const restoreEverything = useCallback(() => {
    setDismissed([]);
    void restoreOnboardingAction({});
  }, []);

  const requestTour = useCallback(() => {
    setTourRequested(true);
    // The tour has to be replayable from anywhere it is offered — /settings and
    // the ⌘K palette both are — but its targets only exist on the dashboard.
    // `tourRequested` outranks the stored dismissal, so no write is needed to
    // replay: an operator who has finished the tour once stays finished, and
    // asking to see it again does not undo that.
    router.push(TOUR_HOME);
  }, [router]);

  const clearTourRequest = useCallback(() => setTourRequested(false), []);

  const value = useMemo<OnboardingContextValue>(
    () => ({
      isDismissed: (key: string) => dismissed.includes(key),
      dismiss,
      restore,
      restoreHelpHints,
      restoreEverything,
      tourRequested,
      requestTour,
      clearTourRequest,
    }),
    [
      dismissed,
      dismiss,
      restore,
      restoreHelpHints,
      restoreEverything,
      tourRequested,
      requestTour,
      clearTourRequest,
    ],
  );

  return (
    <OnboardingContext.Provider value={value}>
      {children}
    </OnboardingContext.Provider>
  );
}

/**
 * Throws rather than returning a no-op default. Every consumer is rendered by
 * the dashboard layout, which always provides this — so a missing provider is a
 * wiring mistake, and silently doing nothing would hide it as "onboarding just
 * never appears", the exact bug this whole change exists to fix.
 */
export function useOnboarding(): OnboardingContextValue {
  const value = useContext(OnboardingContext);

  if (!value) {
    throw new Error("useOnboarding must be used inside <OnboardingProvider>");
  }

  return value;
}
