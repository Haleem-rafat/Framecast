"use client";

import { useState, type ComponentProps } from "react";
import { Eye, EyeOff } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * A password input with its own reveal toggle.
 *
 * One component used by all five password fields rather than five copies of the
 * same `useState`, and — this is the part that matters — each *instance* holds
 * its own state. Sign-up and reset both ask for a password and a confirmation,
 * and a single toggle wired to both would reveal the very thing the second
 * field exists to check independently.
 *
 * What it does not do is as deliberate as what it does:
 *
 * - It switches the input's `type` between `password` and `text`. Faking a
 *   reveal with `-webkit-text-security` or a CSS mask leaves the field
 *   *typed* as text, which is what password managers, `autocomplete` and the
 *   browser's own "never save this" heuristics read. `autoComplete` is passed
 *   straight through untouched for the same reason: `current-password` and
 *   `new-password` are how a manager knows which field it is looking at.
 * - The toggle is `type="button"`. Inside a form, a `<button>` with no type is
 *   a submit button — an eye icon that posts the login form is a bug people
 *   only find in production.
 * - It is labelled, and the label changes with the state. An unlabelled icon
 *   button is announced as "button" and nothing else, which on a password field
 *   is useless; `aria-pressed` then carries whether the password is currently
 *   showing. Both change together, so the two agree.
 * - It stays in the tab order. Somebody typing a long generated password with a
 *   keyboard is exactly who needs to check what landed in the field.
 *
 * The button is inside the field rather than beside it, and the input is padded
 * to `pr-11` so the value never runs under it. The two native controls that
 * would otherwise land in the same corner are dealt with: legacy Edge's own
 * reveal (`::-ms-reveal`) and its clear button are hidden, since duplicating
 * this control is worse than not having it, and Chrome's password-manager key
 * renders inside the padded content box, which puts it to the left of the eye
 * rather than under it.
 */
export function AuthPasswordInput({
  className,
  ...props
}: ComponentProps<typeof Input>) {
  const [isRevealed, setIsRevealed] = useState(false);

  return (
    <div className="relative">
      <Input
        {...props}
        type={isRevealed ? "text" : "password"}
        // The caller's classes go first: `pr-11` has to win over the `px-3`
        // every other field in the form is padded with, or the value runs
        // under the eye. Everything else the caller sets is still honoured.
        className={cn(
          className,
          "pr-11 [&::-ms-clear]:hidden [&::-ms-reveal]:hidden",
        )}
      />

      <button
        type="button"
        onClick={() => setIsRevealed((revealed) => !revealed)}
        aria-label={isRevealed ? "Hide password" : "Show password"}
        aria-pressed={isRevealed}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 absolute inset-y-px right-px flex w-10 items-center justify-center rounded-r-[3px] transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        {isRevealed ? (
          <EyeOff className="size-4" aria-hidden="true" />
        ) : (
          <Eye className="size-4" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
