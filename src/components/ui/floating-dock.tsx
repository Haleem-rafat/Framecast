"use client";

import Link from "next/link";
import { useRef, useSyncExternalStore, type ReactNode } from "react";
import {
  motion,
  useMotionValue,
  useSpring,
  useTransform,
  type MotionValue,
} from "motion/react";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

/**
 * Aceternity's Floating Dock, vendored from
 * https://ui.aceternity.com/registry/floating-dock.json.
 *
 * Four deliberate deviations from upstream, all of which exist because
 * upstream's dock is a decorative desktop bar and ours is the *only* way to
 * navigate the studio on a phone:
 *
 * 1. Upstream ships two variants — a magnifying bar hard-coded to `md:flex`
 *    and a collapsing FAB hard-coded to `md:hidden`. Here the bar itself is
 *    the phone navigation (the desktop keeps its sidebar), so the breakpoint
 *    is not baked in: the caller positions and gates this component.
 * 2. `<a href>` became `next/link`. A tab bar that full-page-reloads the app
 *    on every tap is the single loudest tell that something is a website.
 * 3. Magnification is applied only when the pointer is fine *and* the visitor
 *    has not asked for reduced motion. On a touch screen there is no hovering
 *    pointer to magnify toward, so the effect only ever fires mid-tap, moving
 *    the target out from under the finger that is pressing it. `MagnifiedItem`
 *    and `StaticItem` are separate components rather than one component with
 *    conditional hooks, and the static one is what the server renders.
 * 4. Upstream's `gray-200`/`neutral-800` literals became theme tokens, and the
 *    resting item is 44px rather than 40px — the minimum comfortable touch
 *    target, and the floor this whole redesign is held to.
 */

/** Resting size of an item, in px. 44 is the minimum comfortable touch target. */
const ITEM_SIZE = 44;
/** Size of the item directly under a fine pointer. */
const ITEM_SIZE_MAGNIFIED = 68;
const ICON_SIZE = 20;
const ICON_SIZE_MAGNIFIED = 30;
/**
 * How far either side of an item the pointer still affects it. Narrower than
 * upstream's 150 because our bar is sized for a 375px viewport, where a 150px
 * falloff means every item in the dock reacts to every pointer position at
 * once and the whole bar breathes as one.
 */
const MAGNIFY_RADIUS = 110;

const SPRING = { mass: 0.1, stiffness: 150, damping: 12 } as const;

export interface FloatingDockItem {
  title: string;
  icon: ReactNode;
  /** A destination. Omit — and pass `onClick` instead — for an item that opens something. */
  href?: string;
  onClick?: () => void;
  /** Renders the item as the current location, and sets `aria-current`. */
  active?: boolean;
}

const POINTER_FINE_QUERY = "(pointer: fine)";

function subscribeToPointer(onStoreChange: () => void) {
  const media = window.matchMedia(POINTER_FINE_QUERY);
  media.addEventListener("change", onStoreChange);
  return () => media.removeEventListener("change", onStoreChange);
}

/**
 * Whether this device drives a pointer precise enough for magnification to
 * mean anything. The server snapshot is `false`, so the dock is rendered
 * static-and-tappable first and only upgrades on a real mouse — the safe
 * direction to be wrong in, since the static dock is fully functional and the
 * magnified one is not usable by a finger.
 */
function useFinePointer(): boolean {
  return useSyncExternalStore(
    subscribeToPointer,
    () => window.matchMedia(POINTER_FINE_QUERY).matches,
    () => false,
  );
}

export function FloatingDock({
  items,
  className,
  "aria-label": ariaLabel = "Primary",
}: {
  items: FloatingDockItem[];
  className?: string;
  "aria-label"?: string;
}) {
  const finePointer = useFinePointer();
  const prefersReducedMotion = usePrefersReducedMotion();
  const magnify = finePointer && !prefersReducedMotion;

  // `Infinity` reads as "the pointer is nowhere near this dock", which is what
  // every item's distance transform resolves against before the first move.
  const mouseX = useMotionValue(Number.POSITIVE_INFINITY);

  return (
    <nav aria-label={ariaLabel}>
      <ul
        onMouseMove={(event) => mouseX.set(event.pageX)}
        onMouseLeave={() => mouseX.set(Number.POSITIVE_INFINITY)}
        className={cn(
          "bg-background/80 supports-[backdrop-filter]:bg-background/60 flex items-end gap-1 rounded-2xl border p-2 shadow-lg backdrop-blur-lg",
          className,
        )}
      >
        {items.map((item) => (
          <li key={item.title}>
            {magnify ? (
              <MagnifiedItem item={item} mouseX={mouseX} />
            ) : (
              <StaticItem item={item} />
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

function itemClassName(item: FloatingDockItem) {
  return cn(
    "relative flex aspect-square items-center justify-center rounded-full transition-colors",
    item.active
      ? "bg-primary text-primary-foreground"
      : "text-muted-foreground hover:bg-muted hover:text-foreground",
  );
}

/**
 * The link or button every item is wrapped in. Kept separate from the sizing
 * so that the magnified and static items differ only in how big they are —
 * the hit target, the accessible name and the active state are identical.
 */
function DockItemShell({
  item,
  children,
}: {
  item: FloatingDockItem;
  children: ReactNode;
}) {
  const shared = {
    // The label is the item's only text: the dock is icons, so without this
    // every tab announces as "link".
    children: (
      <>
        {children}
        <span className="sr-only">{item.title}</span>
      </>
    ),
    className:
      "focus-visible:ring-ring/50 flex rounded-full outline-none focus-visible:ring-3",
  };

  if (item.href) {
    return (
      <Link
        href={item.href}
        aria-current={item.active ? "page" : undefined}
        {...shared}
      />
    );
  }

  return <button type="button" onClick={item.onClick} {...shared} />;
}

function StaticItem({ item }: { item: FloatingDockItem }) {
  return (
    <DockItemShell item={item}>
      <span
        className={cn(itemClassName(item), "[&_svg]:size-5")}
        style={{ width: ITEM_SIZE, height: ITEM_SIZE }}
      >
        {item.icon}
      </span>
    </DockItemShell>
  );
}

function MagnifiedItem({
  item,
  mouseX,
}: {
  item: FloatingDockItem;
  mouseX: MotionValue<number>;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  const distance = useTransform(mouseX, (value) => {
    const bounds = ref.current?.getBoundingClientRect() ?? { x: 0, width: 0 };
    return value - bounds.x - bounds.width / 2;
  });

  const size = useSpring(
    useTransform(
      distance,
      [-MAGNIFY_RADIUS, 0, MAGNIFY_RADIUS],
      [ITEM_SIZE, ITEM_SIZE_MAGNIFIED, ITEM_SIZE],
    ),
    SPRING,
  );
  const iconSize = useSpring(
    useTransform(
      distance,
      [-MAGNIFY_RADIUS, 0, MAGNIFY_RADIUS],
      [ICON_SIZE, ICON_SIZE_MAGNIFIED, ICON_SIZE],
    ),
    SPRING,
  );

  return (
    <DockItemShell item={item}>
      <motion.span
        ref={ref}
        style={{ width: size, height: size }}
        className={cn(itemClassName(item), "group/dock-item")}
      >
        {/* Upstream animates this label in and out with AnimatePresence; CSS
         * gets the same result here without a second piece of state, and
         * without a mount animation running on a device that never hovers. */}
        <span className="bg-popover text-popover-foreground pointer-events-none absolute -top-9 left-1/2 -translate-x-1/2 rounded-md border px-2 py-0.5 text-xs whitespace-pre opacity-0 transition-opacity group-hover/dock-item:opacity-100">
          {item.title}
        </span>
        <motion.span
          style={{ width: iconSize, height: iconSize }}
          className="flex items-center justify-center [&_svg]:size-full"
        >
          {item.icon}
        </motion.span>
      </motion.span>
    </DockItemShell>
  );
}
