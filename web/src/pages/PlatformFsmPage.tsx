import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";

import { consoleHref } from "../lib/consoleUrl";
import { ko } from "../i18n/ko";

const landing = ko.landing;
const fsm = ko.storefront.platformFsm;

/** Anchor sub-nav (features / pricing / FAQ). */
const SUBNAV = [
  { href: "#features", label: landing.nav.features },
  { href: "#pricing", label: landing.nav.pricing },
  { href: "#faq", label: landing.nav.faq },
] as const;

/**
 * Public FSM-platform showcase (#6). Routed child of PublicLayout (which
 * supplies the dark site-header + footer), so this returns only its own <main>
 * content. It introduces the KNL-built FSM/CX operator console to public
 * visitors using the EXISTING ko.landing.* copy (hero, full feature matrix,
 * subscription, FAQ) plus a Dashboards & Observability and Governance callout
 * (ko.storefront.platformFsm.*). The gated console owns /platform; this public
 * page is mounted at /platform-fsm.
 */
export default function PlatformFsmPage() {
  const consoleLink = consoleHref();

  return (
    <main className="flex-1 bg-ink text-white">
      {/* Hero */}
      <section
        aria-labelledby="fsm-hero-title"
        className="px-5 pb-[clamp(40px,5vw,64px)] pt-[clamp(72px,9vw,120px)] sm:px-8 lg:px-12"
      >
        <div className="mx-auto max-w-[1240px]">
          <p className="mb-4 text-[13px] font-black uppercase tracking-[0.14em] text-signal">
            {landing.hero.eyebrow}
          </p>
          <h1
            id="fsm-hero-title"
            className="m-0 max-w-[820px] text-[clamp(40px,6vw,72px)] font-extrabold leading-[1.05] tracking-[-0.02em]"
          >
            {landing.hero.title}
          </h1>
          <p className="mt-6 max-w-[760px] text-[clamp(17px,2vw,22px)] leading-[1.7] text-white/80">
            {landing.hero.subtitle}
          </p>
          <p className="mt-5 max-w-[760px] text-[15px] leading-[1.7] text-white/60">
            {fsm.meta.intro}
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <a
              href={consoleLink}
              className="inline-flex min-h-[52px] items-center justify-center gap-3 rounded bg-signal px-[22px] font-black text-ink transition-transform focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white motion-safe:hover:-translate-y-0.5"
            >
              {landing.hero.primaryConsole}
              <ArrowRight aria-hidden="true" size={20} />
            </a>
            <a
              href="#features"
              className="inline-flex min-h-[52px] items-center justify-center rounded border border-white/35 bg-white/10 px-[22px] font-black text-white transition-transform focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white motion-safe:hover:-translate-y-0.5"
            >
              {landing.hero.secondary}
            </a>
          </div>
          <p className="mt-6 max-w-[640px] text-[14px] leading-[1.6] text-white/55">
            {landing.hero.authNote}
          </p>
          {/* Anchor sub-nav */}
          <nav
            aria-label={landing.nav.features}
            className="mt-10 flex flex-wrap gap-2.5 border-t border-white/15 pt-6"
          >
            {SUBNAV.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="inline-flex min-h-[44px] items-center rounded border border-white/25 px-4 text-[14px] font-bold text-white/85 transition-colors hover:border-signal hover:text-signal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
              >
                {item.label}
              </a>
            ))}
          </nav>
        </div>
      </section>

      {/* Feature matrix (6 groups) */}
      <section
        id="features"
        aria-labelledby="fsm-features-title"
        className="scroll-mt-[88px] border-t border-white/10 px-5 py-[clamp(72px,9vw,120px)] sm:px-8 lg:px-12"
      >
        <div className="mx-auto max-w-[1240px]">
          <p className="mb-3 text-[13px] font-black uppercase tracking-[0.14em] text-signal">
            {landing.nav.features}
          </p>
          <h2
            id="fsm-features-title"
            className="m-0 text-[clamp(28px,3.4vw,44px)] font-extrabold leading-[1.12]"
          >
            {landing.features.title}
          </h2>
          <p className="mt-5 max-w-[760px] text-[17px] leading-[1.7] text-white/75">
            {landing.features.subtitle}
          </p>
          <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {landing.features.groups.map((group) => (
              <article
                key={group.title}
                className="flex flex-col rounded-xl border border-white/15 bg-white/[0.03] p-6"
              >
                <h3 className="m-0 text-xl font-extrabold text-signal">
                  {group.title}
                </h3>
                <ul className="m-0 mt-4 grid list-none gap-4 p-0">
                  {group.items.map((item) => (
                    <li key={item.name}>
                      <p className="m-0 text-[15px] font-bold text-white">
                        {item.name}
                      </p>
                      <p className="m-0 mt-1 text-[14px] leading-[1.6] text-white/65">
                        {item.desc}
                      </p>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* Dashboards & Observability callout */}
      <section
        aria-labelledby="fsm-dashboards-title"
        className="border-t border-signal bg-white/[0.02] px-5 py-[clamp(72px,9vw,120px)] sm:px-8 lg:px-12"
      >
        <div className="mx-auto max-w-[1240px]">
          <p className="mb-3 text-[13px] font-black uppercase tracking-[0.14em] text-signal">
            {fsm.dashboards.eyebrow}
          </p>
          <h2
            id="fsm-dashboards-title"
            className="m-0 max-w-[820px] text-[clamp(28px,3.4vw,44px)] font-extrabold leading-[1.12]"
          >
            {fsm.dashboards.title}
          </h2>
          <div className="mt-10 grid gap-6 md:grid-cols-3">
            {landing.features.groups[4].items.map((item) => (
              <article
                key={item.name}
                className="rounded-xl border border-brand-teal/40 bg-brand-teal/[0.08] p-6"
              >
                <h3 className="m-0 text-lg font-extrabold text-white">
                  {item.name}
                </h3>
                <p className="m-0 mt-2 text-[14px] leading-[1.6] text-white/70">
                  {item.desc}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* Governance & multi-tenancy callout */}
      <section
        aria-labelledby="fsm-governance-title"
        className="border-t border-white/10 px-5 py-[clamp(72px,9vw,120px)] sm:px-8 lg:px-12"
      >
        <div className="mx-auto max-w-[1240px]">
          <p className="mb-3 text-[13px] font-black uppercase tracking-[0.14em] text-signal">
            {fsm.governance.eyebrow}
          </p>
          <h2
            id="fsm-governance-title"
            className="m-0 max-w-[820px] text-[clamp(28px,3.4vw,44px)] font-extrabold leading-[1.12]"
          >
            {fsm.governance.title}
          </h2>
          <div className="mt-10 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {landing.features.groups[5].items.map((item) => (
              <article
                key={item.name}
                className="rounded-xl border border-white/15 bg-white/[0.03] p-6"
              >
                <h3 className="m-0 text-lg font-extrabold text-white">
                  {item.name}
                </h3>
                <p className="m-0 mt-2 text-[14px] leading-[1.6] text-white/70">
                  {item.desc}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* Subscription */}
      <section
        id="pricing"
        aria-labelledby="fsm-pricing-title"
        className="scroll-mt-[88px] border-t border-signal bg-white/[0.02] px-5 py-[clamp(72px,9vw,120px)] sm:px-8 lg:px-12"
      >
        <div className="mx-auto max-w-[1240px]">
          <p className="mb-3 text-[13px] font-black uppercase tracking-[0.14em] text-signal">
            {landing.nav.pricing}
          </p>
          <h2
            id="fsm-pricing-title"
            className="m-0 text-[clamp(28px,3.4vw,44px)] font-extrabold leading-[1.12]"
          >
            {landing.pricing.title}
          </h2>
          <p className="mt-5 max-w-[760px] text-[17px] leading-[1.7] text-white/75">
            {landing.pricing.subtitle}
          </p>
          <div className="mt-10 max-w-[680px] rounded-xl border border-white/15 bg-white/[0.03] p-8">
            <h3 className="m-0 text-2xl font-extrabold text-signal">
              {landing.pricing.planName}
            </h3>
            <p className="m-0 mt-4 text-[16px] leading-[1.7] text-white/80">
              {landing.pricing.planDesc}
            </p>
            <Link
              to="/support/new"
              className="mt-7 inline-flex min-h-[52px] items-center justify-center gap-3 rounded bg-signal px-[22px] font-black text-ink transition-transform focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white motion-safe:hover:-translate-y-0.5"
            >
              {landing.pricing.cta}
              <ArrowRight aria-hidden="true" size={20} />
            </Link>
            <p className="m-0 mt-5 text-[14px] leading-[1.6] text-white/55">
              {landing.pricing.note}
            </p>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section
        id="faq"
        aria-labelledby="fsm-faq-title"
        className="scroll-mt-[88px] border-t border-white/10 px-5 py-[clamp(72px,9vw,120px)] sm:px-8 lg:px-12"
      >
        <div className="mx-auto max-w-[1240px]">
          <h2
            id="fsm-faq-title"
            className="m-0 text-[clamp(28px,3.4vw,44px)] font-extrabold leading-[1.12]"
          >
            {landing.faq.title}
          </h2>
          <dl className="m-0 mt-10 grid gap-5">
            {landing.faq.items.map((item) => (
              <div
                key={item.q}
                className="rounded-xl border border-white/15 bg-white/[0.03] p-6"
              >
                <dt className="m-0 text-lg font-extrabold text-white">
                  {item.q}
                </dt>
                <dd className="m-0 mt-2 text-[15px] leading-[1.7] text-white/70">
                  {item.a}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* Footer console CTA */}
      <section
        aria-labelledby="fsm-cta-title"
        className="border-t border-signal px-5 py-[clamp(40px,5vw,64px)] sm:px-8 lg:px-12"
      >
        <div className="mx-auto flex max-w-[1240px] flex-col items-start gap-6 sm:flex-row sm:items-center sm:justify-between">
          <h2
            id="fsm-cta-title"
            className="m-0 text-[clamp(22px,3vw,32px)] font-extrabold leading-[1.12]"
          >
            {landing.hero.title}
          </h2>
          <a
            href={consoleLink}
            className="inline-flex min-h-[52px] items-center justify-center gap-3 rounded bg-signal px-[22px] font-black text-ink transition-transform focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white motion-safe:hover:-translate-y-0.5"
          >
            {landing.nav.console}
            <ArrowRight aria-hidden="true" size={20} />
          </a>
        </div>
      </section>
    </main>
  );
}
