import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";

import { ko } from "../i18n/ko";
import { cn } from "../lib/utils";

const t = ko.storefront.home;

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
  { to: "/contact#quick-inquiry", label: t.quickFinder.inquiry },
] as const;

/** Dark proof strip metrics. */
const PROOF = [
  t.proofStrip.rental,
  t.proofStrip.maintenance,
  t.proofStrip.used,
  t.proofStrip.contact,
] as const;

/**
 * KNL storefront home (#6). Routed child of PublicLayout (which supplies the
 * dark site-header + footer), so this returns only its own <main> content:
 * dark photo hero with a left gradient scrim, Quick Finder shortcuts, the
 * Service Map gateway grid, a dark proof strip, and the amber contact band.
 * All copy comes from ko.storefront.home.*.
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
          className="absolute inset-0 scale-[1.03] bg-cover bg-center"
          style={{ backgroundImage: "url('/sales/asset-04.jpg')" }}
          aria-hidden="true"
        />
        <div
          className="absolute inset-0 bg-gradient-to-r from-[#050d14]/[0.86] via-[#050d14]/60 to-[#050d14]/25"
          aria-hidden="true"
        />
        <div className="relative z-[1] mx-auto w-full max-w-[1240px] px-5 pb-[74px] pt-[130px] sm:px-8 lg:px-[110px]">
          <p className="mb-4 text-[13px] font-black uppercase text-signal">
            {t.hero.eyebrow}
          </p>
          <h1
            id="home-hero-title"
            className="m-0 max-w-[820px] text-[clamp(44px,7.5vw,88px)] font-extrabold leading-[1.04]"
          >
            {t.hero.title}
          </h1>
          <p className="mt-6 max-w-[660px] text-[clamp(18px,2vw,24px)] leading-[1.58] text-white/85">
            {t.hero.copy}
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Link
              to="/contact#quick-inquiry"
              className="inline-flex min-h-[54px] items-center justify-center gap-3.5 rounded border border-signal bg-signal px-[22px] font-black text-[#14120c] transition-transform hover:-translate-y-0.5"
            >
              {t.hero.primary}
              <ArrowRight aria-hidden="true" size={20} />
            </Link>
            <Link
              to="/rental"
              className="inline-flex min-h-[54px] items-center justify-center gap-3.5 rounded border border-white/35 bg-white/10 px-[22px] font-black text-white transition-transform hover:-translate-y-0.5"
            >
              {t.hero.secondary}
            </Link>
          </div>
        </div>
      </section>

      {/* Quick Finder: shortcut tiles to the main pages */}
      <section
        aria-labelledby="home-finder-title"
        className="relative z-[3] border-b border-line bg-white shadow-[0_22px_70px_rgba(5,18,32,0.18)]"
      >
        <div className="mx-auto grid max-w-[1240px] items-end gap-7 px-5 py-[34px] sm:px-8 lg:grid-cols-[minmax(260px,0.8fr)_1.6fr] lg:px-10">
          <div>
            <p className="mb-2 text-[13px] font-black uppercase text-brand-teal">
              {t.quickFinder.eyebrow}
            </p>
            <h2
              id="home-finder-title"
              className="m-0 text-[clamp(29px,4vw,52px)] font-extrabold leading-[1.12]"
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
                className="flex min-h-[58px] items-center justify-center rounded bg-ink px-3.5 text-center font-black text-white transition-colors hover:bg-ink/90"
              >
                {s.label}
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Service Map: gateway grid of purpose-built pages */}
      <section className="px-5 py-[clamp(74px,10vw,128px)] sm:px-8 lg:px-10">
        <div className="mx-auto max-w-[1240px]">
          <div className="mb-10 grid items-end gap-6 lg:grid-cols-[minmax(280px,0.75fr)_1fr]">
            <div>
              <p className="mb-2 text-[13px] font-black uppercase text-brand-teal">
                {t.serviceMap.eyebrow}
              </p>
              <h2 className="m-0 text-[clamp(29px,4vw,52px)] font-extrabold leading-[1.12]">
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
                className="group grid gap-4 overflow-hidden rounded-lg border border-line bg-white transition-all hover:-translate-y-[3px] hover:shadow-[0_22px_70px_rgba(5,18,32,0.18)]"
              >
                <img
                  src={image}
                  alt={card.imageAlt}
                  className="aspect-[4/3] w-full object-cover"
                />
                <span className="mx-[22px] text-[13px] font-black uppercase text-brand-teal">
                  {card.tag}
                </span>
                <h3 className="mx-[22px] m-0 text-2xl font-extrabold">
                  {card.title}
                </h3>
                <p className="mx-[22px] mb-6 mt-0 leading-[1.6] text-steel">
                  {card.copy}
                </p>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Proof strip: dark band of value metrics */}
      <section className="bg-ink px-5 py-[34px] text-white sm:px-8 lg:px-10">
        <div className="mx-auto grid max-w-[1240px] gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
          {PROOF.map((item) => (
            <article
              key={item.title}
              className="grid gap-1.5 border-l-[3px] border-signal pl-[18px]"
            >
              <strong className="text-[26px] font-extrabold">{item.title}</strong>
              <span className="text-white/70">{item.caption}</span>
            </article>
          ))}
        </div>
      </section>

      {/* Contact band: amber CTA to the customer center */}
      <section className="bg-signal px-5 py-[46px] sm:px-8 lg:px-10">
        <div className="mx-auto grid max-w-[1240px] items-center gap-6 lg:grid-cols-[1.3fr_auto_auto]">
          <div>
            <p className="mb-4 text-[13px] font-black uppercase text-ink/70">
              {t.contactBand.eyebrow}
            </p>
            <h2 className="m-0 text-[clamp(29px,4vw,52px)] font-extrabold leading-[1.12]">
              {t.contactBand.title}
            </h2>
          </div>
          <div className="grid gap-1">
            <span className="text-[13px] font-black text-ink/70">
              {t.contactBand.numberLabel}
            </span>
            <a
              href={ko.storefront.nav.phoneHref}
              className="text-[clamp(24px,3vw,36px)] font-extrabold"
            >
              {t.contactBand.number}
            </a>
          </div>
          <Link
            to="/contact#quick-inquiry"
            className={cn(
              "inline-flex min-h-[54px] items-center justify-center rounded border border-ink bg-ink px-[22px] font-black text-white",
              "transition-transform hover:-translate-y-0.5",
            )}
          >
            {t.contactBand.cta}
          </Link>
        </div>
      </section>
    </main>
  );
}
