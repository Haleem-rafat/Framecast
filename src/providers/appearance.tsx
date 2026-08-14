import type { AccentColour, ThemePreference } from "@/generated/prisma/enums";
import { ACCENT_STYLE_ID, accentStyleSheet } from "@/lib/accent";

/**
 * The operator's appearance, put into the page before the browser paints it.
 *
 * ---------------------------------------------------------------------------
 * Why this is not a `useEffect`
 * ---------------------------------------------------------------------------
 * Both halves below are stored on the server, which means both are known at
 * render time — so there is no honest reason for either to arrive after
 * hydration. An accent applied in an effect means the first frame is the
 * *previous* operator's studio (or the monochrome default), and then it changes
 * under them. That is the flash `next-themes` exists to avoid for light/dark,
 * and the same technique fixes it here: put the answer in the HTML.
 *
 * ---------------------------------------------------------------------------
 * The accent: a stylesheet, and nothing else
 * ---------------------------------------------------------------------------
 * The `<style>` element carries the whole accent. No class, no attribute, no
 * script — it is in the markup, so it is in effect the moment the parser reaches
 * it, which is before any studio chrome below it has been parsed, let alone
 * painted. There is no frame in which the wrong colour exists.
 *
 * It also has to be a stylesheet rather than an inline `style=` on a wrapper
 * element, for a reason that is easy to miss: Radix portals its dropdowns,
 * dialogs, selects and the mobile sheet to `document.body`, outside whatever
 * wrapper the dashboard layout renders. Custom properties set on a wrapper are
 * inherited, so anything portalled out of it would fall back to the monochrome
 * `:root` values and a dialog's Save button would be the wrong colour. Declaring
 * on `:root` reaches every portal for free.
 *
 * This is the `.marketing` idea — redefine the same token *names* under a
 * narrower scope and let every shadcn component pick them up untouched — with
 * the scope moved from a class to the route. `.marketing` scopes by wrapper
 * because MarketingShell and the studio coexist in one document tree; this
 * scopes by *page*, because the element is only ever rendered by the dashboard
 * layout. Marketing and auth pages never render it, so they never see it, and
 * their fixed brand palette is untouched.
 *
 * ---------------------------------------------------------------------------
 * The theme: reconciling a server column with next-themes' localStorage
 * ---------------------------------------------------------------------------
 * `UserSetting.theme` was stored and ignored: next-themes keeps its choice in
 * `localStorage`, which never reaches the server, so an operator's theme did
 * not follow them to a second browser. Making the column authoritative means
 * getting a value from the server into next-themes *before* it reads storage.
 *
 * next-themes initialises its React state with
 * `useState(() => getTheme(storageKey, defaultTheme))` — a `localStorage` read
 * that happens at hydration. The script below runs during parsing, long before
 * the bundle has even loaded, so by the time next-themes looks, storage already
 * holds the server's value and next-themes adopts it as its own. From then on
 * the toggle behaves exactly as it always did, and `ThemeToggle` writes each
 * change back to the column so the next browser starts from the right place.
 *
 * The script also applies the resolved class itself rather than waiting for
 * hydration. next-themes' own inline script sits higher in the document and
 * will already have applied the *stale* stored value; correcting it here, a few
 * nodes later and still during parse, is the same parser-blocking technique and
 * closes the same gap.
 */

const THEME_CLASSES: Record<ThemePreference, string> = {
  LIGHT: "light",
  DARK: "dark",
  // next-themes' own name for "ask the OS", not a class it ever applies.
  SYSTEM: "system",
};

/**
 * next-themes' default `storageKey`. Not configured in ThemeProvider, so the
 * default is what is actually in use; naming it here keeps the coupling
 * visible instead of leaving a bare "theme" string in a template literal.
 */
const THEME_STORAGE_KEY = "theme";

function themeSyncScript(theme: ThemePreference): string {
  const stored = THEME_CLASSES[theme];

  // Everything interpolated is a literal from the map above, so no value an
  // operator controls reaches this script.
  return [
    "(function(){try{",
    `var want=${JSON.stringify(stored)},key=${JSON.stringify(THEME_STORAGE_KEY)};`,
    "if(localStorage.getItem(key)!==want)localStorage.setItem(key,want);",
    'var resolved=want==="system"?(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):want;',
    "var el=document.documentElement;",
    // Mirrors what next-themes does with attribute="class": remove every theme
    // name, add the resolved one, and tell the browser which built-in control
    // colours to use. Diverging here would leave two writers fighting over the
    // same class list.
    'el.classList.remove("light","dark");el.classList.add(resolved);',
    "el.style.colorScheme=resolved;",
    // Storage can throw in a partitioned or private context. A studio that
    // fails to render because a preference could not be saved is a far worse
    // outcome than one that falls back to next-themes' own behaviour.
    "}catch(e){}})()",
  ].join("");
}

export interface AppearanceProps {
  theme: ThemePreference;
  accent: AccentColour;
}

/**
 * Rendered as the first thing inside the dashboard layout, so both land ahead
 * of every pixel they affect.
 *
 * Neither element is memoised, unlike next-themes' `ThemeScript`. React
 * reconciles an existing `<script>` in place, and updating an element's
 * `innerHTML` does not re-execute it — so a re-render of this layout (a
 * `router.refresh()` after the settings form saves, say) cannot replay the
 * script. What it *does* do is refresh the `<style>` element's contents from
 * the newly-saved accent, which is exactly right: a saved value should win over
 * whatever the picker was previewing.
 */
export function Appearance({ theme, accent }: AppearanceProps) {
  return (
    <>
      <style
        id={ACCENT_STYLE_ID}
        // Generated entirely from the frozen palette in src/lib/accent.ts — an
        // unrecognised accent yields the empty string rather than any part of
        // the stored value. See `accentStyleSheet`.
        dangerouslySetInnerHTML={{ __html: accentStyleSheet(accent) }}
      />
      <script dangerouslySetInnerHTML={{ __html: themeSyncScript(theme) }} />
    </>
  );
}
