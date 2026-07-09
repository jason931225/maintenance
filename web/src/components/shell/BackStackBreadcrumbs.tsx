import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { useAuth } from "../../context/auth";
import { useCurrentTitle } from "../../context/title";
import { ko } from "../../i18n/ko";
import { cn } from "../../lib/utils";
import { navItemLabel } from "./nav-labels";
import { visibleNavItemForPath } from "./nav";

interface BackStackCrumb {
  href: string;
  pathname: string;
  label: string;
}

const MAX_BACK_STACK = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRelativeAppPath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//");
}

function readBackStackSeed(
  state: unknown,
  roles: readonly string[] | undefined,
  groupRoles: readonly string[] | undefined,
  featureGrants: readonly string[] | undefined,
): BackStackCrumb | undefined {
  if (!isRecord(state) || !isRecord(state.backStackSeed)) return undefined;
  const seed = state.backStackSeed;
  if (
    typeof seed.href === "string" &&
    typeof seed.pathname === "string" &&
    typeof seed.label === "string" &&
    isRelativeAppPath(seed.href) &&
    isRelativeAppPath(seed.pathname) &&
    seed.href.split(/[?#]/, 1)[0] === seed.pathname
  ) {
    const navItem = visibleNavItemForPath(
      seed.pathname,
      roles,
      groupRoles,
      featureGrants,
    );
    if (navItem?.href !== seed.pathname) return undefined;
    return { href: seed.href, pathname: seed.pathname, label: navItemLabel(navItem.key) };
  }
  return undefined;
}

function fallbackPathLabel(pathname: string): string {
  const segment = pathname.split("/").filter(Boolean).at(-1);
  return segment ? decodeURIComponent(segment) : ko.shell.title;
}

function routeLabel(
  pathname: string,
  title: string,
  roles: readonly string[] | undefined,
  groupRoles: readonly string[] | undefined,
  featureGrants: readonly string[] | undefined,
): string {
  const navItem = visibleNavItemForPath(
    pathname,
    roles,
    groupRoles,
    featureGrants,
  );
  if (navItem?.href === pathname) return navItemLabel(navItem.key);
  return title || (navItem ? navItemLabel(navItem.key) : fallbackPathLabel(pathname));
}

/**
 * Session-local route back-stack rendered as breadcrumbs. It is intentionally
 * client-side and ephemeral: enough to preserve the user's navigation context
 * across object/detail screens without inventing a global history service.
 */
export function BackStackBreadcrumbs() {
  const { session } = useAuth();
  const title = useCurrentTitle();
  const location = useLocation();
  const [crumbs, setCrumbs] = useState<BackStackCrumb[]>([]);

  useEffect(() => {
    const href = `${location.pathname}${location.search}`;
    const label = routeLabel(
      location.pathname,
      title,
      session?.roles,
      session?.group_roles,
      session?.feature_grants,
    );
    const seed = readBackStackSeed(
      location.state,
      session?.roles,
      session?.group_roles,
      session?.feature_grants,
    );
    const timer = window.setTimeout(() => {
      setCrumbs((previous) => {
        const seeded =
          seed && seed.pathname !== location.pathname
            ? [
                ...previous.filter(
                  (crumb) =>
                    crumb.pathname !== seed.pathname &&
                    crumb.pathname !== location.pathname,
                ),
                seed,
              ]
            : previous;
        const next = [
          ...seeded.filter((crumb) => crumb.pathname !== location.pathname),
          { href, pathname: location.pathname, label },
        ].slice(-MAX_BACK_STACK);
        const unchanged =
          next.length === previous.length &&
          next.every(
            (crumb, index) =>
              crumb.href === previous[index]?.href &&
              crumb.pathname === previous[index]?.pathname &&
              crumb.label === previous[index]?.label,
          );
        return unchanged ? previous : next;
      });
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [
    location.pathname,
    location.search,
    location.state,
    session?.roles,
    session?.group_roles,
    session?.feature_grants,
    title,
  ]);

  if (crumbs.length === 0) return null;

  return (
    <nav
      aria-label={ko.shell.breadcrumbs.label}
      className="mb-4 rounded-lg border border-line bg-white px-3 py-2 text-xs text-steel shadow-sm"
    >
      <ol className="flex flex-wrap items-center gap-2">
        {crumbs.map((crumb, index) => {
          const current = index === crumbs.length - 1;
          return (
            <li
              key={`${crumb.pathname}-${String(index)}`}
              className="flex items-center gap-2"
            >
              {index > 0 ? (
                <span aria-hidden="true" className="text-line">
                  /
                </span>
              ) : null}
              {current ? (
                <span
                  aria-current="page"
                  className="max-w-64 truncate font-semibold text-ink"
                >
                  {crumb.label}
                </span>
              ) : (
                <Link
                  to={crumb.href}
                  className={cn(
                    "max-w-56 truncate rounded-sm text-steel hover:text-ink hover:underline",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
                  )}
                >
                  {crumb.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
