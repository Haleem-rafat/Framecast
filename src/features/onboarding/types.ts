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
}

/**
 * The contract the dashboard page depends on, so it never needs to know which
 * implementation of `OnboardingReader` is bound.
 */
export interface OnboardingReader {
  getChecklist(userId: string): Promise<OnboardingChecklist>;
}
