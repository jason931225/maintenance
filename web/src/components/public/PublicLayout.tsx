import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";

import webPackage from "../../../package.json";
import { consoleHref } from "../../lib/consoleUrl";
import { ko } from "../../i18n/ko";
import { cn } from "../../lib/utils";

const COOKIE_NOTICE_KEY = "knl_cookie_notice_v1";
const COPYRIGHT_YEAR = new Date().getFullYear();
const WEB_VERSION = webPackage.version;

const NAV_ITEMS = [
  { to: "/", label: ko.storefront.nav.home, end: true },
  { to: "/rental", label: ko.storefront.nav.rental, end: false },
  { to: "/used", label: ko.storefront.nav.used, end: false },
  { to: "/maintenance", label: ko.storefront.nav.maintenance, end: false },
  { to: "/about", label: ko.storefront.nav.about, end: false },
  { to: "/contact", label: ko.storefront.nav.contact, end: false },
] as const;

const SERVICES_LINKS = [
  { to: "/rental", label: ko.storefront.nav.rental },
  { to: "/used", label: ko.storefront.nav.used },
  { to: "/maintenance", label: ko.storefront.nav.maintenance },
  { to: "/support/new", label: ko.storefront.nav.request },
] as const;

const COMPANY_LINKS = [
  { to: "/about", label: ko.storefront.nav.about },
  { to: "/contact", label: ko.storefront.nav.contact },
  { to: "/privacy", label: ko.storefront.nav.privacy },
] as const;

const FAMILY_LINKS = [
  { href: "https://www.cossok.com/", label: ko.storefront.footer.family.coss },
  {
    href: "https://www.bestec-kr.com/",
    label: ko.storefront.footer.family.bestec,
  },
] as const;

/**
 * Public storefront layout route (#6 KNL). Renders the dark KNL three-cluster
 * site-header (left brand logo, center page nav with a fenced-off FSM-platform
 * link, right action cluster with an outlined sign-in button + the amber
 * support-request button, mobile hamburger drawer) and the 4-column footer
 * sitemap, with the matched page rendered via <Outlet/>. Each routed page
 * therefore supplies only its own <main> content. All copy comes from
 * ko.storefront.nav.* / ko.storefront.footer.*.
 */
export function PublicLayout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [cookieNoticeVisible, setCookieNoticeVisible] = useState(false);
  const { pathname } = useLocation();

  // Operator-console (staff) link target: crosses to console.knllogistic.com in
  // production, stays same-origin (/login) on the console host, dev, and previews.
  const consoleLink = consoleHref();

  // Close the mobile drawer whenever the route changes (e.g. tapping a link).
  // Defer off the synchronous effect body to avoid cascading renders.
  useEffect(() => {
    void Promise.resolve().then(() => {
      setMenuOpen(false);
    });
  }, [pathname]);

  useEffect(() => {
    void Promise.resolve().then(() => {
      try {
        setCookieNoticeVisible(
          window.localStorage.getItem(COOKIE_NOTICE_KEY) !== "accepted",
        );
      } catch {
        setCookieNoticeVisible(true);
      }
    });
  }, []);

  function acceptCookieNotice() {
    try {
      window.localStorage.setItem(COOKIE_NOTICE_KEY, "accepted");
    } finally {
      setCookieNoticeVisible(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#f6f8fa] text-ink">
      <header className="sticky top-0 z-30 flex h-[76px] items-center justify-between gap-4 bg-ink/95 px-5 text-white backdrop-blur sm:px-8 lg:px-12">
        {/* LEFT: brand logo */}
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

        {/* CENTER: page nav + fenced FSM-platform link */}
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
          <NavLink
            to="/platform-fsm"
            aria-label={ko.storefront.nav.platformAria}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2 border-l border-white/20 pl-6 opacity-90 transition-colors hover:text-signal hover:opacity-100",
                isActive && "text-signal opacity-100",
              )
            }
          >
            <span
              aria-hidden="true"
              className="inline-block h-1.5 w-1.5 rounded-full bg-signal"
            />
            {ko.storefront.nav.platform}
          </NavLink>
        </nav>

        {/* RIGHT: action cluster */}
        <div className="flex items-center gap-3">
          <a
            href={consoleLink}
            aria-label={ko.storefront.nav.loginAria}
            className="hidden min-h-[44px] items-center rounded border border-white/35 bg-white/10 px-4 text-sm font-bold text-white transition-colors hover:border-signal hover:text-signal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal sm:inline-flex"
          >
            {ko.storefront.nav.login}
          </a>
          <Link
            to="/support/new"
            className="hidden min-h-[44px] items-center rounded border border-signal bg-signal px-4 text-sm font-extrabold text-[#14120c] transition-transform focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white motion-safe:hover:-translate-y-0.5 sm:inline-flex"
          >
            {ko.storefront.nav.request}
          </Link>
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
            className="absolute right-0 top-0 grid h-full w-[min(360px,86vw)] content-start gap-1.5 overflow-y-auto bg-ink px-7 pb-8 pt-[90px] text-white shadow-2xl"
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

            {/* Action stack — sign-in promoted to the top */}
            <a
              href={consoleLink}
              aria-label={ko.storefront.nav.loginAria}
              className="inline-flex min-h-[52px] items-center justify-center rounded border border-white/35 bg-white/10 px-4 text-[20px] font-extrabold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
            >
              {ko.storefront.nav.login}
            </a>
            <Link
              to="/support/new"
              className="inline-flex min-h-[52px] items-center justify-center rounded bg-signal px-4 text-[20px] font-extrabold text-[#14120c] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              {ko.storefront.nav.request}
            </Link>
            <a
              href={ko.storefront.nav.phoneHref}
              className="mb-3 inline-flex min-h-[44px] items-center justify-center text-[18px] font-bold text-white/70 transition-colors hover:text-signal focus-visible:text-signal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
            >
              {ko.storefront.nav.phoneConsult}
            </a>

            {/* Section: page nav */}
            <p className="mt-2 text-[12px] font-black uppercase tracking-[0.14em] text-signal">
              {ko.storefront.footer.sitemap.services}
            </p>
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    "border-b border-white/15 py-3.5 text-[20px] font-extrabold",
                    isActive && "text-signal",
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}

            {/* Section: FSM platform */}
            <p className="mt-4 text-[12px] font-black uppercase tracking-[0.14em] text-signal">
              {ko.storefront.footer.sitemap.platform}
            </p>
            <NavLink
              to="/platform-fsm"
              aria-label={ko.storefront.nav.platformAria}
              className={({ isActive }) =>
                cn(
                  "border-b border-white/15 py-3.5 text-[20px] font-extrabold",
                  isActive && "text-signal",
                )
              }
            >
              {ko.storefront.nav.platform}
            </NavLink>
          </aside>
        </div>
      ) : null}

      <Outlet />

      {/* Footer: 4-column sitemap */}
      <footer className="bg-ink px-5 py-[clamp(40px,5vw,64px)] text-white/70 sm:px-8 lg:px-12">
        <div className="mx-auto max-w-[1240px]">
          <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.4fr_repeat(4,1fr)]">
            {/* Brand block */}
            <div className="flex flex-col gap-4">
              <img
                src="/sales/asset-01.png"
                alt={ko.storefront.footer.logoAlt}
                className="w-[92px]"
              />
              <p className="m-0 text-sm leading-[1.7]">
                {ko.storefront.footer.address}
              </p>
              <p className="m-0 text-sm">{ko.storefront.footer.email}</p>
              <p className="m-0 text-sm text-white/55">
                {ko.storefront.footer.tagline}
              </p>
            </div>

            {/* Column: services */}
            <nav aria-label={ko.storefront.footer.sitemap.services}>
              <p className="mb-3 text-[12px] font-black uppercase tracking-[0.14em] text-signal">
                {ko.storefront.footer.sitemap.services}
              </p>
              <ul className="m-0 grid list-none gap-2 p-0 text-sm">
                {SERVICES_LINKS.map((item) => (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      className="inline-flex min-h-[32px] items-center transition-colors hover:text-signal focus-visible:text-signal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>

            {/* Column: FSM platform */}
            <nav aria-label={ko.storefront.footer.sitemap.platform}>
              <p className="mb-3 text-[12px] font-black uppercase tracking-[0.14em] text-signal">
                {ko.storefront.footer.sitemap.platform}
              </p>
              <ul className="m-0 grid list-none gap-2 p-0 text-sm">
                <li>
                  <Link
                    to="/platform-fsm"
                    className="inline-flex min-h-[32px] items-center transition-colors hover:text-signal focus-visible:text-signal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
                  >
                    {ko.storefront.nav.platform}
                  </Link>
                </li>
                <li>
                  <a
                    href={consoleLink}
                    aria-label={ko.storefront.nav.loginAria}
                    className="inline-flex min-h-[32px] items-center transition-colors hover:text-signal focus-visible:text-signal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
                  >
                    {ko.storefront.footer.sitemap.console}
                  </a>
                </li>
              </ul>
            </nav>

            {/* Column: company */}
            <nav aria-label={ko.storefront.footer.sitemap.company}>
              <p className="mb-3 text-[12px] font-black uppercase tracking-[0.14em] text-signal">
                {ko.storefront.footer.sitemap.company}
              </p>
              <ul className="m-0 grid list-none gap-2 p-0 text-sm">
                {COMPANY_LINKS.map((item) => (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      className="inline-flex min-h-[32px] items-center transition-colors hover:text-signal focus-visible:text-signal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>

            {/* Column: family sites */}
            <nav aria-label={ko.storefront.footer.sitemap.family}>
              <p className="mb-3 text-[12px] font-black uppercase tracking-[0.14em] text-signal">
                {ko.storefront.footer.sitemap.family}
              </p>
              <ul className="m-0 grid list-none gap-2 p-0 text-sm">
                {FAMILY_LINKS.map((item) => (
                  <li key={item.href}>
                    <a
                      href={item.href}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-[32px] items-center transition-colors hover:text-signal focus-visible:text-signal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
                    >
                      {item.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
          <div className="mt-10 flex flex-col gap-2 border-t border-white/10 pt-6 text-xs text-white/45 sm:flex-row sm:items-center sm:justify-between">
            <p className="m-0">
              {ko.storefront.footer.copyright.replace(
                "{year}",
                String(COPYRIGHT_YEAR),
              )}
            </p>
            <p className="m-0">
              {ko.storefront.footer.version.replace("{version}", WEB_VERSION)}
            </p>
          </div>
        </div>
      </footer>

      {cookieNoticeVisible ? (
        <section
          role="region"
          aria-label={ko.storefront.cookie.aria}
          className="fixed bottom-4 left-4 right-4 z-50 mx-auto grid max-w-[920px] gap-4 rounded-2xl border border-white/20 bg-ink p-5 text-white shadow-2xl sm:grid-cols-[1fr_auto] sm:items-center"
        >
          <div className="grid gap-1.5">
            <p className="m-0 text-sm font-extrabold text-signal">
              {ko.storefront.cookie.title}
            </p>
            <p className="m-0 text-sm leading-6 text-white/75">
              {ko.storefront.cookie.body}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              to="/privacy"
              className="inline-flex min-h-[40px] items-center text-sm font-bold text-white/75 underline-offset-4 transition-colors hover:text-signal hover:underline focus-visible:text-signal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
            >
              {ko.storefront.cookie.details}
            </Link>
            <button
              type="button"
              onClick={acceptCookieNotice}
              className="inline-flex min-h-[40px] items-center rounded bg-signal px-4 text-sm font-extrabold text-[#14120c] transition-transform focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white motion-safe:hover:-translate-y-0.5"
            >
              {ko.storefront.cookie.accept}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
