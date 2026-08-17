export interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  /** Where the operator goes to complete this step. */
  href: string;
  complete: boolean;
}

export interface OnboardingChecklist {
  steps: OnboardingStep[];
  /** True once every step is complete — the dashboard hides the checklist entirely then. */
  isComplete: boolean;
  /**
   * How far along, for the progress line. Derived here rather than in the card
   * so the two can never disagree about what "3 of 6" means.
   */
  completedCount: number;
}

/**
 * What the operator has already read and put away. One flat set of keys — see
 * src/features/onboarding/dismissal.ts for the vocabulary.
 */
export interface OnboardingProgress {
  dismissed: string[];
}

/**
 * The contract the dashboard page depends on, so it never needs to know which
 * implementation of `OnboardingReader` is bound.
 */
export interface OnboardingReader {
  getChecklist(userId: string): Promise<OnboardingChecklist>;
  /** Read on every authenticated page render, so it is one indexed lookup. */
  getProgress(userId: string): Promise<OnboardingProgress>;
  dismiss(userId: string, key: string): Promise<OnboardingProgress>;
  /**
   * Puts things back. `keys` restores exactly those; omitting it restores
   * everything, which is what "replay onboarding" means.
   */
  restore(userId: string, keys?: readonly string[]): Promise<OnboardingProgress>;
}
