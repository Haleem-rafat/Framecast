"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { Fragment, useMemo } from "react";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { findNavItemByPath } from "@/config/navigation";

interface Crumb {
  label: string;
  href: string;
}

function toLabel(segment: string): string {
  return segment
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Derives crumbs from the URL. Segments that match a known nav entry use its
 * title; the rest are title-cased. Opaque ids (UUIDs) are labelled "Details"
 * rather than shown raw.
 */
function buildCrumbs(pathname: string): Crumb[] {
  const segments = pathname.split("/").filter(Boolean);

  return segments.map((segment, index) => {
    const href = `/${segments.slice(0, index + 1).join("/")}`;
    const navItem = findNavItemByPath(href);

    if (navItem && navItem.href === href) {
      return { label: navItem.title, href };
    }

    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        segment,
      );

    return { label: isUuid ? "Details" : toLabel(segment), href };
  });
}

/**
 * The last crumb on its own, for the phone topbar.
 *
 * A trail is a desktop affordance: it earns its width by showing where you are
 * *and* offering the way back up. At 375px it shows neither well — "Videos /
 * Details" truncates into noise beside the controls it shares the bar with —
 * while the leaf alone still answers the only question the bar is asked, which
 * is which page this is. Going back up is what the dock is for.
 */
/**
 * The way back out of a page the phone has no other way out of.
 *
 * The topbar's own comment above says going back up is what the dock is for,
 * and for a top-level page that is true. It is not true one level down: the
 * dock lists six destinations and a "More" sheet, none of which is "the list
 * this detail belongs to". So standing on a video, a channel, a series or a
 * new-schedule form, a phone had the browser's own gesture and nothing else —
 * and inside an installed PWA there is no browser chrome to gesture with.
 *
 * Where "up" is comes from `findNavItemByPath`, not from the crumb trail, and
 * that is the whole reason this is three lines instead of a special case per
 * route. The parent *crumb* of `/automation/series/new` is `/automation/series`,
 * which has no page — linking to it would be a 404 on a control whose entire
 * job is to be the safe way out. The parent *nav entry* is `/automation`, which
 * is a page by definition, because that is what being in `navigation.ts` means.
 *
 * A path whose longest match is itself (every top-level page) gets no button,
 * and neither does one under no entry at all — in both cases there is nothing
 * this could point at that the dock does not already offer.
 */
export function AppBackLink() {
  const pathname = usePathname();
  const parent = useMemo(() => findNavItemByPath(pathname), [pathname]);

  if (!parent || parent.href === pathname) return null;

  return (
    <Link
      href={parent.href}
      aria-label={`Back to ${parent.title}`}
      className="hover:bg-accent -ml-2 flex size-9 shrink-0 items-center justify-center rounded-md transition-colors"
    >
      <ChevronLeft className="size-5" />
    </Link>
  );
}

export function AppPageTitle() {
  const pathname = usePathname();
  const crumbs = useMemo(() => buildCrumbs(pathname), [pathname]);
  const current = crumbs.at(-1);

  if (!current) return null;

  return (
    <span className="truncate text-sm font-medium">{current.label}</span>
  );
}

export function AppBreadcrumbs() {
  const pathname = usePathname();
  const crumbs = useMemo(() => buildCrumbs(pathname), [pathname]);

  if (crumbs.length === 0) return null;

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;

          return (
            <Fragment key={crumb.href}>
              <BreadcrumbItem className={isLast ? undefined : "hidden md:block"}>
                {isLast ? (
                  <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink href={crumb.href}>{crumb.label}</BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {!isLast && <BreadcrumbSeparator className="hidden md:block" />}
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
