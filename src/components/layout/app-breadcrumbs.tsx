"use client";

import { usePathname } from "next/navigation";
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
