"use client";

import { useEffect, useRef } from "react";

interface ShortcutModifiers {
  /** Cmd on macOS, Ctrl elsewhere. */
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
  );
}

/**
 * Binds a document-level shortcut. Ignores keystrokes typed into form fields
 * unless the shortcut carries a modifier, so plain-letter bindings stay safe.
 */
export function useKeyboardShortcut(
  key: string,
  handler: () => void,
  modifiers: ShortcutModifiers = {},
): void {
  // Kept in a ref so a new inline handler each render does not rebind the listener.
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const { meta = false, shift = false, alt = false } = modifiers;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== key.toLowerCase()) return;

      const metaPressed = event.metaKey || event.ctrlKey;
      if (meta !== metaPressed) return;
      if (shift !== event.shiftKey) return;
      if (alt !== event.altKey) return;

      if (!meta && !alt && isTypingTarget(event.target)) return;

      event.preventDefault();
      handlerRef.current();
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [key, meta, shift, alt]);
}
