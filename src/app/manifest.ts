import type { MetadataRoute } from "next";

import { SITE_DESCRIPTION, SITE_NAME } from "@/config/site";

/**
 * What turns this from a website on a phone into an application on a phone.
 *
 * The studio was already responsive — a mobile dock, safe-area insets, dialogs
 * that become drawers below `md`. What it was missing is the layer that makes a
 * browser treat it as an app at all: without a manifest there is no
 * install-to-home-screen, no standalone window, no splash screen, and the
 * browser's own chrome stays on screen taking a fifth of a phone's height on
 * every single page.
 *
 * ## The fields that are doing work
 *
 * `display: "standalone"` is the whole point. Installed, the app opens in its
 * own window with no URL bar and no tab strip, and the operating system gives
 * it a task-switcher entry of its own. This is what "looks like an application"
 * actually means on a phone.
 *
 * `id` is set explicitly and must never change. A browser keys an installed app
 * on it; changing it later makes every existing install orphaned and the next
 * visit offers to install a *second* copy.
 *
 * `start_url` is `/dashboard` rather than `/`. Somebody who has put this on
 * their home screen has an account — the landing page's job is to persuade a
 * stranger, and it is the wrong first screen for a returning operator. Signed
 * out, `/dashboard` redirects to sign-in, which is the right screen for them
 * instead.
 *
 * `background_color` matches the mark's own tile rather than the app's page
 * background, because it paints the splash screen *behind* the icon during the
 * fraction of a second before the first frame renders — a white splash under a
 * dark tile flashes, and it is the flash people describe as "it feels like a
 * web page".
 *
 * ## What is deliberately absent
 *
 * No `shortcuts`. They are a good idea here — "Make one video", "Approvals" —
 * and they are a bad idea *first*: each one needs its own maskable icon, and an
 * installed shortcut pointing at a screen that later moves is worse than no
 * shortcut. Worth adding once this layer has been used for a while.
 *
 * No service worker, and therefore no offline. Every screen in this studio
 * reads live rows — what is rendering, what is queued, what published — and a
 * cached shell showing yesterday's state would be actively misleading about a
 * pipeline that spends money. An install with no offline story is still a real
 * install; a wrong one is not.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    // Never change this. See the doc comment above.
    id: "/?app=framecast",
    name: SITE_NAME,
    // What fits under a home-screen icon before the launcher truncates it.
    short_name: SITE_NAME,
    description: SITE_DESCRIPTION,
    start_url: "/dashboard",
    // The whole app, so an internal link never bounces the operator out into a
    // browser tab mid-session.
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#171717",
    theme_color: "#171717",
    categories: ["productivity", "business", "video"],
    lang: "en-GB",
    dir: "ltr",
    icons: [
      {
        src: "/icons/192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      // Android crops an installed icon to the launcher's own shape and only
      // the middle ~80% survives. Without this entry the mark comes out with
      // its corners shaved off — see the route that draws it.
      {
        src: "/icons/maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
