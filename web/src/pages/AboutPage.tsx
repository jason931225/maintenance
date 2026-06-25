import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";

import { ko } from "../i18n/ko";

/**
 * About page (#6 KNL storefront). Routed child of PublicLayout — returns only
 * its own <main>; the dark site-header and footer come from the layout.
 *
 * Sections: a dark photo page-hero (asset-17, left gradient scrim), a Company
 * split-panel intro, a muted Certification grid (ISO 9001 / 14001 / 45001 →
 * asset-08/09/10), a Partners text-wordmark wall (mirrors the home credibility
 * band), and a closing online-intake CTA band. All Korean copy is read from
 * ko.storefront.about.*.
 */

const a = ko.storefront.about;

// Certification images, paired to ko.storefront.about.cert.items in order.
const CERT_IMAGES = [
  "/sales/asset-08.jpg",
  "/sales/asset-09.jpg",
  "/sales/asset-10.jpg",
] as const;

export default function AboutPage() {
  return (
    <main className="flex-1">
      {/* Page hero — dark photo with a left gradient scrim. */}
      <section
        aria-labelledby="about-hero-title"
        className="relative grid min-h-[62svh] items-end overflow-hidden bg-ink bg-cover bg-center text-white"
        style={{ backgroundImage: "url('/sales/asset-17.jpg')" }}
      >
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-gradient-to-r from-ink/[0.88] to-ink/[0.58]"
        />
        <div className="relative mx-auto w-full max-w-[1240px] px-5 pb-[clamp(54px,8vw,96px)] pt-[clamp(110px,14vw,160px)] sm:px-8 lg:px-10">
          <p className="mb-4 text-[13px] font-black uppercase tracking-[0.14em] text-signal">
            {a.hero.eyebrow}
          </p>
          <h1
            id="about-hero-title"
            className="balance-text m-0 max-w-[820px] text-[clamp(38px,6vw,72px)] font-extrabold leading-[1.08] tracking-[-0.02em]"
          >
            {a.hero.title}
          </h1>
          <p className="mt-[22px] max-w-[720px] text-[clamp(17px,2vw,22px)] leading-[1.7] text-white/85">
            {a.hero.copy}
          </p>
        </div>
      </section>

      {/* Company — split heading / lead copy panel. */}
      <section
        aria-labelledby="about-company-title"
        className="py-[clamp(74px,10vw,128px)]"
      >
        <div className="mx-auto grid max-w-[1240px] grid-cols-1 items-start gap-10 px-5 sm:px-8 md:grid-cols-[minmax(280px,0.7fr)_1fr] lg:px-10">
          <div>
            <p className="mb-3 text-[13px] font-black uppercase tracking-[0.14em] text-brand-teal">
              {a.company.eyebrow}
            </p>
            <h2
              id="about-company-title"
              className="m-0 text-[clamp(28px,3.4vw,44px)] font-extrabold leading-[1.12]"
            >
              {a.company.title}
            </h2>
          </div>
          <p className="m-0 text-[18px] leading-[1.7] text-steel">
            {a.company.copy}
          </p>
        </div>
      </section>

      {/* Certification — muted band, 3-up figure grid. */}
      <section
        aria-labelledby="about-cert-title"
        className="bg-muted-panel py-[clamp(74px,10vw,128px)]"
      >
        <div className="mx-auto max-w-[1240px] px-5 sm:px-8 lg:px-10">
          <div className="max-w-[780px]">
            <p className="mb-3 text-[13px] font-black uppercase tracking-[0.14em] text-brand-teal">
              {a.cert.eyebrow}
            </p>
            <h2
              id="about-cert-title"
              className="m-0 text-[clamp(28px,3.4vw,44px)] font-extrabold leading-[1.12]"
            >
              {a.cert.title}
            </h2>
          </div>
          <div className="mt-8 grid grid-cols-1 gap-[18px] sm:grid-cols-2 md:grid-cols-3">
            {a.cert.items.map((item, i) => (
              <figure
                key={item.name}
                className="m-0 rounded-xl border border-line bg-white p-6 text-center"
              >
                <img
                  src={CERT_IMAGES[i]}
                  alt={item.imageAlt}
                  className="mx-auto max-h-[320px] object-contain"
                />
                <figcaption className="mt-4 text-lg font-extrabold">
                  {item.name}
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      {/* Partners — text-wordmark wall (mirrors the home credibility band). */}
      <section
        aria-labelledby="about-partners-title"
        className="py-[clamp(74px,10vw,128px)]"
      >
        <div className="mx-auto max-w-[1240px] px-5 sm:px-8 lg:px-10">
          <div className="max-w-[780px]">
            <p className="mb-3 text-[13px] font-black uppercase tracking-[0.14em] text-brand-teal">
              {a.partners.eyebrow}
            </p>
            <h2
              id="about-partners-title"
              className="m-0 text-[clamp(28px,3.4vw,44px)] font-extrabold leading-[1.12]"
            >
              {a.partners.title}
            </h2>
          </div>
          <ul
            aria-label={a.partners.aria}
            className="m-0 mt-8 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
          >
            {a.partners.items.map((partner) => (
              <li
                key={partner.name}
                className="inline-flex min-h-[56px] items-center justify-center rounded border border-line bg-white px-3 text-center text-[14px] font-bold uppercase tracking-[0.08em] text-steel"
              >
                {partner.name}
              </li>
            ))}
          </ul>
          <p className="m-0 mt-5 text-[13px] leading-[1.6] text-steel">
            {a.partners.note}
          </p>
        </div>
      </section>

      {/* Closing CTA band — amber, online intake first, phone last resort. */}
      <section
        aria-labelledby="about-cta-title"
        className="bg-signal px-5 py-[clamp(40px,5vw,64px)] sm:px-8 lg:px-10"
      >
        <div className="mx-auto grid max-w-[1240px] items-center gap-6 lg:grid-cols-[1.5fr_auto]">
          <div>
            <p className="mb-3 text-[13px] font-black uppercase tracking-[0.14em] text-ink/70">
              {a.ctaBand.eyebrow}
            </p>
            <h2
              id="about-cta-title"
              className="m-0 text-[clamp(28px,3.4vw,44px)] font-extrabold leading-[1.12]"
            >
              {a.ctaBand.title}
            </h2>
            <p className="mt-3 max-w-[640px] text-[17px] leading-[1.7] text-ink/80">
              {a.ctaBand.copy}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              to="/support/new"
              className="inline-flex min-h-[52px] items-center justify-center gap-2.5 rounded border border-ink bg-ink px-[22px] font-black text-white transition-transform focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink motion-safe:hover:-translate-y-0.5"
            >
              {a.ctaBand.cta}
              <ArrowRight aria-hidden="true" size={18} />
            </Link>
            <a
              href={ko.storefront.nav.phoneHref}
              className="inline-flex min-h-[52px] items-center justify-center px-2 font-bold text-ink underline-offset-4 transition-colors hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              {a.ctaBand.secondary}
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}
