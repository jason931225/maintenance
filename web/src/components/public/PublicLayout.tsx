import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";

import { consoleHref } from "../../lib/consoleUrl";
import { ko } from "../../i18n/ko";
import { cn } from "../../lib/utils";

const NAV_ITEMS = [
  { to: "/", label: ko.storefront.nav.home, end: true },
  { to: "/rental", label: ko.storefront.nav.rental, end: false },
  { to: "/used", label: ko.storefront.nav.used, end: false },
  { to: "/maintenance", label: ko.storefront.nav.maintenance, end: false },
  { to: "/about", label: ko.storefront.nav.about, end: false },
  { to: "/contact", label: ko.storefront.nav.contact, end: false },
] as const;

/**
 * Public storefront layout route (#6 KNL). Renders the dark KNL site-header
 * (logo, desktop nav with active marking, sales phone pill, mobile hamburger
 * drawer) and the footer, with the matched page rendered via <Outlet/>. Each
 * routed page therefore supplies only its own <main> content. All copy comes
 * from ko.storefront.nav.* / ko.storefront.footer.*.
 */
export function PublicLayout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();

  // Operator-console (staff) link target: crosses to fsm.knllogistic.com in
  // production, stays same-origin (/login) on the console host, dev, and previews.
  const consoleLink = consoleHref();

  // Close the mobile drawer whenever the route changes (e.g. tapping a link).
  // Defer off the synchronous effect body to avoid cascading renders.
  useEffect(() => {
    void Promise.resolve().then(() => {
      setMenuOpen(false);
    });
  }, [pathname]);

  return (
    <div className="flex min-h-screen flex-col bg-[#f6f8fa] text-ink">
      <header className="sticky top-0 z-30 flex h-[76px] items-center justify-between bg-ink/95 px-5 text-white backdrop-blur sm:px-8 lg:px-12">
        <Link
          to="/"
          aria-label={ko.storefront.nav.home}
          className="flex items-center"
        >
          <img
            src="/sales/asset-03.svg"
            alt={ko.storefront.footer.logoAlt}
            className="h-8 w-auto"
          />
        </Link>

        <nav
          aria-label={ko.storefront.nav.menuAria}
          className="hidden items-center gap-8 text-[15px] font-bold md:flex"
        >
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  "opacity-90 transition-colors hover:text-signal hover:opacity-100",
                  isActive && "text-signal opacity-100",
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="flex items-center gap-4">
          <a
            href={consoleLink}
            aria-label={ko.storefront.nav.consoleAria}
            className="hidden min-h-[44px] items-center rounded px-3 text-sm font-bold text-white/70 transition-colors hover:text-signal focus-visible:text-signal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal sm:inline-flex"
          >
            {ko.storefront.nav.console}
          </a>
          <a
            href={ko.storefront.nav.phoneHref}
            className="hidden rounded border border-white/35 px-3.5 py-2.5 text-sm font-extrabold sm:inline-block"
          >
            {ko.storefront.nav.phone}
          </a>
          <button
            type="button"
            aria-label={ko.storefront.nav.openMenu}
            aria-expanded={menuOpen}
            onClick={() => {
              setMenuOpen(true);
            }}
            className="inline-flex h-10 w-10 items-center justify-center md:hidden"
          >
            <Menu aria-hidden="true" size={26} />
          </button>
        </div>
      </header>

      {/* Mobile drawer */}
      {menuOpen ? (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-ink/60"
            onClick={() => {
              setMenuOpen(false);
            }}
            aria-hidden="true"
          />
          <aside
            aria-label={ko.storefront.nav.mobileMenuAria}
            className="absolute right-0 top-0 grid h-full w-[min(360px,86vw)] content-start gap-1.5 bg-ink px-7 pb-8 pt-[90px] text-white shadow-2xl"
          >
            <button
              type="button"
              aria-label={ko.storefront.nav.closeMenu}
              onClick={() => {
                setMenuOpen(false);
              }}
              className="absolute right-6 top-6 inline-flex h-10 w-10 items-center justify-center rounded border border-white/60"
            >
              <X aria-hidden="true" size={20} />
            </button>
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    "border-b border-white/15 py-4 text-[22px] font-extrabold",
                    isActive && "text-signal",
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
            <a
              href={ko.storefront.nav.phoneHref}
              className="border-b border-white/15 py-4 text-[22px] font-extrabold"
            >
              {ko.storefront.nav.phoneConsult}
            </a>
            <a
              href={consoleLink}
              aria-label={ko.storefront.nav.consoleAria}
              className="mt-3 inline-flex min-h-[44px] items-center text-[18px] font-bold text-white/70 transition-colors hover:text-signal focus-visible:text-signal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
            >
              {ko.storefront.nav.console}
            </a>
          </aside>
        </div>
      ) : null}

      <Outlet />

      <footer className="bg-ink px-5 py-8 text-white/70 sm:px-8 lg:px-12">
        <div className="mx-auto flex max-w-[1240px] flex-col items-start gap-4 sm:flex-row sm:items-center">
          <img
            src="/sales/asset-01.png"
            alt={ko.storefront.footer.logoAlt}
            className="w-[92px]"
          />
          <div className="flex-1 text-sm">
            <p className="m-0">
              {ko.storefront.footer.address} · {ko.storefront.footer.email}
            </p>
          </div>
          <p className="m-0 text-sm">{ko.storefront.footer.tagline}</p>
          <a
            href={consoleLink}
            aria-label={ko.storefront.nav.consoleAria}
            className="inline-flex min-h-[44px] items-center text-sm font-bold text-white/70 transition-colors hover:text-signal focus-visible:text-signal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
          >
            {ko.storefront.nav.console}
          </a>
        </div>
      </footer>
    </div>
  );
}
