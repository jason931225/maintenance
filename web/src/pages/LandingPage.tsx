import {
  BarChart3,
  CalendarClock,
  ClipboardList,
  KeyRound,
  Receipt,
  Smartphone,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Link } from "react-router-dom";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";

const BRAND_DOMAIN = "knllogistic.com";

// One icon per feature group, in the same order as ko.landing.features.groups.
const GROUP_ICONS: readonly LucideIcon[] = [
  ClipboardList, // intake / dispatch
  Smartphone, // field service / mobile
  CalendarClock, // preventive maintenance / approvals
  Receipt, // settlement / assets
  BarChart3, // data / ops
  Users, // collaboration / platform
];

/**
 * Public, unauthenticated marketing landing page (GitHub #10). Mounted outside
 * the auth guard. Presents the product, its capabilities, a subscription
 * enquiry, contact, and FAQ. The login/console CTA reflects the current session;
 * the subscription + contact CTAs hand off to the existing public inquiry form
 * (/support/new) — the real customer window — rather than any fabricated channel.
 */
export function LandingPage() {
  const { session, restoring, logout } = useAuth();

  const authed = !restoring && Boolean(session);
  const consoleHref = session?.isPlatform ? "/platform" : "/dispatch";

  function renderAuthCta(size?: "sm") {
    // Decide login-vs-logout only once the silent boot refresh settles.
    if (restoring) {
      return null;
    }
    if (session) {
      return (
        <div className="flex items-center gap-2">
          <Button asChild size={size}>
            <Link to={consoleHref}>{ko.landing.nav.console}</Link>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size={size}
            onClick={() => {
              void logout();
            }}
          >
            {ko.landing.nav.logout}
          </Button>
        </div>
      );
    }
    return (
      <Button asChild size={size}>
        <Link to="/login">{ko.landing.nav.login}</Link>
      </Button>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-950">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-slate-950 focus:px-4 focus:py-2 focus:text-white"
      >
        {ko.landing.skipToContent}
      </a>

      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <a href="#main" className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="inline-flex h-8 items-center rounded-md bg-slate-950 px-2 text-sm font-bold tracking-tight text-white"
            >
              {ko.landing.brand}
            </span>
            <span className="flex flex-col leading-none">
              <span className="text-sm font-semibold text-slate-950">
                {ko.landing.product}
              </span>
              <span className="text-xs text-slate-500">{ko.landing.brandFull}</span>
            </span>
          </a>
          <nav
            aria-label={ko.landing.product}
            className="hidden items-center gap-1 md:flex"
          >
            <a
              href="#features"
              className="rounded-md px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-950"
            >
              {ko.landing.nav.features}
            </a>
            <a
              href="#pricing"
              className="rounded-md px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-950"
            >
              {ko.landing.nav.pricing}
            </a>
            <a
              href="#faq"
              className="rounded-md px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-950"
            >
              {ko.landing.nav.faq}
            </a>
            <a
              href="#contact"
              className="rounded-md px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-950"
            >
              {ko.landing.nav.contact}
            </a>
          </nav>
          {renderAuthCta("sm")}
        </div>
      </header>

      <main id="main">
        {/* Hero */}
        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
          <div className="mx-auto max-w-3xl text-center">
            <Badge className="border-slate-300 bg-white text-slate-700">
              {ko.landing.hero.eyebrow}
            </Badge>
            <h1 className="mt-5 text-3xl font-bold leading-tight tracking-tight text-slate-950 sm:text-4xl">
              {ko.landing.hero.title}
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-slate-600">
              {ko.landing.hero.subtitle}
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              {restoring ? null : authed ? (
                <Button asChild>
                  <Link to={consoleHref}>{ko.landing.hero.primaryConsole}</Link>
                </Button>
              ) : (
                <Button asChild>
                  <Link to="/login">{ko.landing.hero.primaryLogin}</Link>
                </Button>
              )}
              <Button asChild variant="secondary">
                <a href="#features">{ko.landing.hero.secondary}</a>
              </Button>
            </div>
            <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-slate-500">
              <KeyRound aria-hidden="true" size={14} />
              {ko.landing.hero.authNote}
            </p>
          </div>
        </section>

        {/* Features */}
        <section
          id="features"
          aria-labelledby="features-title"
          className="mx-auto max-w-6xl scroll-mt-16 px-4 py-12 sm:px-6 lg:px-8"
        >
          <div className="max-w-2xl">
            <h2
              id="features-title"
              className="text-2xl font-semibold text-slate-950"
            >
              {ko.landing.features.title}
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              {ko.landing.features.subtitle}
            </p>
          </div>
          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {ko.landing.features.groups.map((group, index) => {
              const Icon = GROUP_ICONS[index] ?? ClipboardList;
              return (
                <Card key={group.title} className="grid content-start gap-4">
                  <div className="flex items-center gap-2.5">
                    <span
                      aria-hidden="true"
                      className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-slate-100 text-slate-700"
                    >
                      <Icon size={18} />
                    </span>
                    <h3 className="text-base font-semibold text-slate-950">
                      {group.title}
                    </h3>
                  </div>
                  <ul className="grid gap-3">
                    {group.items.map((item) => (
                      <li key={item.name} className="grid gap-0.5">
                        <span className="text-sm font-semibold text-slate-900">
                          {item.name}
                        </span>
                        <span className="text-sm leading-relaxed text-slate-600">
                          {item.desc}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Card>
              );
            })}
          </div>
        </section>

        {/* Pricing / subscription */}
        <section
          id="pricing"
          aria-labelledby="pricing-title"
          className="mx-auto max-w-6xl scroll-mt-16 px-4 py-12 sm:px-6 lg:px-8"
        >
          <div className="max-w-2xl">
            <h2
              id="pricing-title"
              className="text-2xl font-semibold text-slate-950"
            >
              {ko.landing.pricing.title}
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              {ko.landing.pricing.subtitle}
            </p>
          </div>
          <Card className="mt-6 grid gap-5 sm:max-w-xl">
            <div className="grid gap-1">
              <h3 className="text-lg font-semibold text-slate-950">
                {ko.landing.pricing.planName}
              </h3>
              <p className="text-sm leading-relaxed text-slate-600">
                {ko.landing.pricing.planDesc}
              </p>
            </div>
            <Button asChild className="justify-self-start">
              <Link to="/support/new">{ko.landing.pricing.cta}</Link>
            </Button>
            <p className="text-xs text-slate-500">{ko.landing.pricing.note}</p>
          </Card>
        </section>

        {/* Contact / inquiry */}
        <section
          id="contact"
          aria-labelledby="contact-title"
          className="mx-auto max-w-6xl scroll-mt-16 px-4 py-12 sm:px-6 lg:px-8"
        >
          <div className="max-w-2xl">
            <h2
              id="contact-title"
              className="text-2xl font-semibold text-slate-950"
            >
              {ko.landing.contact.title}
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              {ko.landing.contact.subtitle}
            </p>
          </div>
          <Card className="mt-6 grid gap-5 sm:max-w-xl">
            <p className="text-sm leading-relaxed text-slate-600">
              {ko.landing.contact.inquiryDesc}
            </p>
            <Button asChild className="justify-self-start">
              <Link to="/support/new">{ko.landing.contact.inquiryCta}</Link>
            </Button>
            <div className="flex items-center gap-2 border-t border-slate-100 pt-4 text-sm">
              <span className="text-slate-500">
                {ko.landing.contact.domainLabel}
              </span>
              <a
                href={`https://${BRAND_DOMAIN}`}
                className="font-medium text-slate-900 underline-offset-2 hover:underline"
                rel="noreferrer"
              >
                {BRAND_DOMAIN}
              </a>
            </div>
          </Card>
        </section>

        {/* FAQ */}
        <section
          id="faq"
          aria-labelledby="faq-title"
          className="mx-auto max-w-6xl scroll-mt-16 px-4 py-12 sm:px-6 lg:px-8"
        >
          <h2 id="faq-title" className="text-2xl font-semibold text-slate-950">
            {ko.landing.faq.title}
          </h2>
          <div className="mt-6 grid gap-3 sm:max-w-3xl">
            {ko.landing.faq.items.map((item) => (
              <details
                key={item.q}
                className="group rounded-lg border border-slate-200 bg-white px-4 py-3"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-slate-950">
                  {item.q}
                  <span
                    aria-hidden="true"
                    className="text-slate-400 transition-transform group-open:rotate-45"
                  >
                    +
                  </span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-slate-600">
                  {item.a}
                </p>
              </details>
            ))}
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-8 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <div className="flex flex-col gap-0.5">
            <span className="font-semibold text-slate-900">
              {ko.landing.brandFull} · {ko.landing.product}
            </span>
            <span className="text-xs">{ko.landing.footer.tagline}</span>
          </div>
          <span className="text-xs">
            © {new Date().getFullYear()} {ko.landing.brandFull}.{" "}
            {ko.landing.footer.rights}
          </span>
        </div>
      </footer>
    </div>
  );
}
