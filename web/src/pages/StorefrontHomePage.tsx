import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";

import { consoleHref } from "../lib/consoleUrl";
import { ko } from "../i18n/ko";
import { cn } from "../lib/utils";

const t = ko.storefront.home;
const landing = ko.landing;
const partners = ko.storefront.about.partners;

/** Service Map gateway cards (4: rental / used / maintenance / about). */
const GATEWAY_CARDS = [
  { to: "/rental", image: "/sales/asset-04.jpg", card: t.serviceMap.cards.rental },
  { to: "/used", image: "/sales/asset-06.jpg", card: t.serviceMap.cards.used },
  {
    to: "/maintenance",
    image: "/sales/asset-05.jpg",
    card: t.serviceMap.cards.maintenance,
  },
  { to: "/about", image: "/sales/asset-17.jpg", card: t.serviceMap.cards.about },
] as const;

/** Quick Finder shortcut tiles. */
const SHORTCUTS = [
  { to: "/rental", label: t.quickFinder.rental },
  { to: "/used", label: t.quickFinder.used },
  { to: "/maintenance", label: t.quickFinder.maintenance },
  { to: "/support/new", label: t.quickFinder.maintenanceRequest },
] as const;

/** FSM platform band capability chips. */
const PLATFORM_CHIPS = [
  t.platform.chips.dispatch,
  t.platform.chips.field,
  t.platform.chips.kpi,
] as const;

/**
 * KNL storefront home (#6). Routed child of PublicLayout (which supplies the
 * dark site-header + footer), so this returns only its own <main> content:
 * dark photo hero with a left gradient scrim, Quick Finder shortcuts, the
 * Service Map gateway grid, a partner-brand credibility band, a fenced
 * FSM-platform band, and the amber contact band. All copy comes
 * from ko.storefront.* / ko.landing.*.
 */
export default function StorefrontHomePage() {
  return (
    <main className="flex-1">
      {/* Hero: dark photo with left gradient scrim */}
      <section
        aria-labelledby="home-hero-title"
        className="relative grid min-h-[82svh] items-center overflow-hidden text-white"
      >
        <div
          className="absolute inset-0 bg-cover bg-center motion-safe:scale-[1.03]"
          style={{ backgroundImage: "url('/sales/asset-04.jpg')" }}
          aria-hidden="true"
        />
        <div
          className="absolute inset-0 bg-gradient-to-r from-ink/[0.86] via-ink/60 to-ink/25"
          aria-hidden="true"
        />
        <div className="relative z-[1] mx-auto w-full max-w-[1240px] px-5 pb-[74px] pt-[130px] sm:px-8 lg:px-12">
          <p className="mb-4 text-[13px] font-black uppercase tracking-[0.14em] text-signal">
            {t.hero.eyebrow}
          </p>
          <h1
            id="home-hero-title"
            className="balance-text m-0 max-w-[15ch] text-[clamp(44px,7vw,84px)] font-extrabold leading-[1.02] tracking-[-0.025em]"
          >
            {t.hero.titleOneStop}
          </h1>
          <p className="mt-6 max-w-[560px] text-[clamp(17px,2vw,22px)] leading-[1.7] text-white/85">
            {t.hero.copy}
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-x-4 gap-y-3">
            {/* Primary action — the single dominant CTA. */}
            <Link
              to="/support/new"
              className="inline-flex min-h-[54px] items-center justify-center gap-3 rounded bg-signal px-7 text-[17px] font-black text-ink shadow-[0_10px_30px_rgba(246,181,33,0.25)] transition-transform focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white motion-safe:hover:-translate-y-0.5"
            >
              {t.hero.primary}
              <ArrowRight aria-hidden="true" size={20} />
            </Link>
            {/* Secondary — quiet ghost outline. */}
            <Link
              to="/rental"
              className="inline-flex min-h-[54px] items-center justify-center rounded border border-white/30 px-6 font-bold text-white/90 transition-colors hover:border-white/70 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              {t.hero.secondary}
            </Link>
            {/* Tertiary — understated text link to the console. */}
            <Link
              to="/platform-fsm"
              className="group inline-flex min-h-[54px] items-center gap-1.5 px-1 text-[15px] font-bold text-white/70 underline-offset-4 transition-colors hover:text-signal hover:underline focus-visible:text-signal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              {t.hero.platformLink}
              <ArrowRight
                aria-hidden="true"
                size={16}
                className="transition-transform motion-safe:group-hover:translate-x-0.5"
              />
            </Link>
          </div>
        </div>
      </section>

      {/* Quick Finder: shortcut tiles to the main pages */}
      <section
        aria-labelledby="home-finder-title"
        className="relative z-[3] border-b border-line bg-white shadow-[0_22px_70px_rgba(5,18,32,0.18)]"
      >
        <div className="mx-auto grid max-w-[1240px] items-end gap-7 px-5 py-[34px] sm:px-8 lg:grid-cols-[minmax(260px,0.8fr)_1.6fr] lg:px-12">
          <div>
            <p className="mb-2 text-[13px] font-black uppercase tracking-[0.14em] text-brand-teal">
              {t.quickFinder.eyebrow}
            </p>
            <h2
              id="home-finder-title"
              className="m-0 text-[clamp(28px,3.4vw,44px)] font-extrabold leading-[1.12]"
            >
              {t.quickFinder.title}
            </h2>
          </div>
          <div
            aria-label={t.quickFinder.shortcutsAria}
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            {SHORTCUTS.map((s) => (
              <Link
                key={s.to}
                to={s.to}
                className="flex min-h-[58px] items-center justify-center rounded bg-ink px-3.5 text-center font-black text-white transition-colors hover:bg-ink/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                {s.label}
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Service Map: gateway grid of purpose-built pages */}
      <section
        aria-labelledby="home-servicemap-title"
        className="px-5 py-[clamp(72px,9vw,120px)] sm:px-8 lg:px-12"
      >
        <div className="mx-auto max-w-[1240px]">
          <div className="mb-10 grid items-end gap-6 lg:grid-cols-[minmax(280px,0.75fr)_1fr]">
            <div>
              <p className="mb-2 text-[13px] font-black uppercase tracking-[0.14em] text-brand-teal">
                {t.serviceMap.eyebrow}
              </p>
              <h2
                id="home-servicemap-title"
                className="m-0 text-[clamp(28px,3.4vw,44px)] font-extrabold leading-[1.12]"
              >
                {t.serviceMap.title}
              </h2>
            </div>
            <p className="m-0 text-[18px] leading-[1.7] text-steel">
              {t.serviceMap.copy}
            </p>
          </div>
          <div className="grid gap-[18px] sm:grid-cols-2 lg:grid-cols-4">
            {GATEWAY_CARDS.map(({ to, image, card }) => (
              <Link
                key={to}
                to={to}
                className="group flex flex-col overflow-hidden rounded-xl border border-line bg-white transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-teal motion-safe:hover:-translate-y-[3px] motion-safe:hover:shadow-[0_22px_70px_rgba(5,18,32,0.18)]"
              >
                <div className="relative aspect-[4/3] overflow-hidden">
                  <img
                    src={image}
                    alt={card.imageAlt}
                    className="h-full w-full object-cover transition-transform duration-300 motion-safe:group-hover:scale-105"
                  />
                  <div
                    className="absolute inset-0 bg-gradient-to-t from-ink/40 to-transparent"
                    aria-hidden="true"
                  />
                </div>
                <div className="p-6">
                  <span className="text-[13px] font-black uppercase tracking-[0.14em] text-brand-teal">
                    {card.tag}
                  </span>
                  <h3 className="m-0 mt-2 text-2xl font-extrabold">
                    {card.title}
                  </h3>
                  <p className="mb-4 mt-2 leading-[1.6] text-steel">
                    {card.copy}
                  </p>
                  <span className="inline-flex items-center gap-1.5 text-sm font-bold text-brand-teal">
                    {t.serviceMap.cardCta}
                    <ArrowRight aria-hidden="true" size={16} />
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Credibility band: partner brand wall */}
      <section
        aria-labelledby="home-credibility-title"
        className="bg-muted-panel px-5 py-[clamp(72px,9vw,120px)] sm:px-8 lg:px-12"
      >
        <div className="mx-auto max-w-[1240px]">
          <p className="mb-2 text-[13px] font-black uppercase tracking-[0.14em] text-brand-teal">
            {t.credibility.eyebrow}
          </p>
          <h2
            id="home-credibility-title"
            className="m-0 mb-10 text-[clamp(28px,3.4vw,44px)] font-extrabold leading-[1.12]"
          >
            {t.credibility.title}
          </h2>
          <ul
            aria-label={partners.aria}
            className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
          >
            {partners.items.map((item) => (
              <li
                key={item.name}
                className="inline-flex min-h-[56px] items-center justify-center rounded border border-line bg-white px-3 text-center text-[14px] font-bold uppercase tracking-[0.08em] text-steel"
              >
                {item.name}
              </li>
            ))}
          </ul>
          <p className="m-0 mt-5 text-[13px] leading-[1.6] text-steel">
            {t.credibility.partnerNote}
          </p>
        </div>
      </section>

      {/* Fenced FSM platform band: full-bleed dark with a signal top-rule */}
      <section
        aria-labelledby="home-platform-title"
        className="border-t border-signal bg-ink px-5 py-[clamp(72px,9vw,120px)] text-white sm:px-8 lg:px-12"
      >
        <div className="mx-auto max-w-[1240px]">
          <p className="mb-3 text-[13px] font-black uppercase tracking-[0.14em] text-signal">
            {t.platform.eyebrow}
          </p>
          <h2
            id="home-platform-title"
            className="m-0 max-w-[900px] text-[clamp(28px,3.4vw,44px)] font-extrabold leading-[1.12]"
          >
            {landing.hero.title}
          </h2>
          <p className="mt-5 max-w-[760px] text-[17px] leading-[1.7] text-white/80">
            {landing.hero.subtitle}
          </p>
          <ul className="m-0 mt-8 flex list-none flex-wrap gap-2.5 p-0">
            {PLATFORM_CHIPS.map((chip) => (
              <li
                key={chip}
                className="inline-flex min-h-[40px] items-center rounded border border-brand-teal/60 bg-brand-teal/10 px-4 text-[14px] font-bold text-white"
              >
                {chip}
              </li>
            ))}
          </ul>
          <div className="mt-9 flex flex-wrap gap-3">
            <Link
              to="/platform-fsm"
              className="inline-flex min-h-[52px] items-center justify-center gap-3 rounded bg-signal px-[22px] font-black text-ink transition-transform focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white motion-safe:hover:-translate-y-0.5"
            >
              {t.platform.detailCta}
              <ArrowRight aria-hidden="true" size={20} />
            </Link>
            <a
              href={consoleHref()}
              className="inline-flex min-h-[52px] items-center justify-center rounded border border-white/35 bg-white/10 px-[22px] font-black text-white transition-transform focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white motion-safe:hover:-translate-y-0.5"
            >
              {landing.nav.console}
            </a>
          </div>
        </div>
      </section>

      {/* Contact band: amber CTA to the customer center */}
      <section
        aria-labelledby="home-contact-title"
        className="bg-signal px-5 py-[clamp(40px,5vw,64px)] sm:px-8 lg:px-12"
      >
        <div className="mx-auto grid max-w-[1240px] items-center gap-6 lg:grid-cols-[1.3fr_auto_auto]">
          <div>
            <p className="mb-4 text-[13px] font-black uppercase tracking-[0.14em] text-ink/70">
              {t.contactBand.eyebrow}
            </p>
            <h2
              id="home-contact-title"
              className="m-0 text-[clamp(28px,3.4vw,44px)] font-extrabold leading-[1.12]"
            >
              {t.contactBand.title}
            </h2>
          </div>
          <div className="grid gap-1">
            <span className="text-[13px] font-black text-ink/70">
              {t.contactBand.numberLabel}
            </span>
            <a
              href={ko.storefront.nav.phoneHref}
              className="inline-flex min-h-[44px] w-fit items-center text-xl font-extrabold text-ink underline-offset-4 transition-colors hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              {t.contactBand.number}
            </a>
          </div>
          <Link
            to="/support/new"
            className={cn(
              "inline-flex min-h-[52px] items-center justify-center rounded border border-ink bg-ink px-[22px] font-black text-white",
              "transition-transform focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink motion-safe:hover:-translate-y-0.5",
            )}
          >
            {t.contactBand.cta}
          </Link>
        </div>
      </section>
    </main>
  );
}
