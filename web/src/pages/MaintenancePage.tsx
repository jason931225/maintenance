import { Link } from "react-router-dom";
import { ShieldCheck, Siren, ClipboardCheck, ArrowRight } from "lucide-react";

import { ko } from "../i18n/ko";

const SCOPE_ICONS = [ShieldCheck, Siren, ClipboardCheck] as const;

// Online intake deep-link (the dominant CTA target); phone is last resort.
const INTAKE_MAINTENANCE = "/support/new?topic=MAINTENANCE";

/**
 * Maintenance page (#6 KNL). Routed child of PublicLayout — returns only its
 * <main>. Sections: page-hero (asset-05), service-scope cards, operation-care
 * section (asset-07 dark photo) and a repair contact band. The dominant CTA
 * routes to the online intake (/support/new); phone is demoted to last resort.
 * All copy from ko.storefront.maintenance.*.
 */
export default function MaintenancePage() {
  const t = ko.storefront.maintenance;

  return (
    <main className="flex-1">
      {/* Page hero — decorative photo background (asset-05). */}
      <section
        aria-labelledby="maintenance-hero-title"
        className="relative grid min-h-[62svh] items-end text-white"
      >
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: "url('/sales/asset-05.jpg')" }}
        />
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-gradient-to-r from-ink/[0.88] to-ink/[0.58]"
        />
        <div className="relative z-[1] mx-auto w-full max-w-[1240px] px-5 pb-[clamp(54px,8vw,96px)] pt-[clamp(110px,14vw,160px)] sm:px-8 lg:px-10">
          <p className="m-0 mb-4 text-[13px] font-black uppercase tracking-[0.14em] text-signal">
            {t.hero.eyebrow}
          </p>
          <h1
            id="maintenance-hero-title"
            className="m-0 max-w-[820px] text-[clamp(38px,6vw,72px)] font-extrabold leading-[1.08] tracking-[-0.02em]"
          >
            {t.hero.title}
          </h1>
          <p className="mt-[22px] max-w-[720px] text-[clamp(17px,2vw,22px)] leading-[1.7] text-white/85">
            {t.hero.copy}
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Link
              to={INTAKE_MAINTENANCE}
              className="inline-flex min-h-[54px] items-center justify-center gap-2.5 rounded bg-signal px-6 font-black text-ink transition-transform hover:bg-signal-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white motion-safe:hover:-translate-y-0.5"
            >
              {t.hero.primary}
              <ArrowRight aria-hidden="true" size={18} />
            </Link>
            <a
              href="#service-scope"
              className="inline-flex min-h-[54px] items-center justify-center rounded border border-white/35 bg-white/10 px-6 font-black text-white transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              {t.hero.secondary}
            </a>
          </div>
        </div>
      </section>

      {/* Service scope — split heading + 3 info cards */}
      <section
        id="service-scope"
        aria-labelledby="maintenance-scope-title"
        className="scroll-mt-[86px] py-[clamp(74px,10vw,128px)]"
      >
        <div className="mx-auto max-w-[1240px] px-5 sm:px-8 lg:px-10">
          <div className="mb-10 grid items-end gap-6 md:grid-cols-[minmax(280px,0.75fr)_1fr]">
            <div>
              <p className="m-0 mb-4 text-[13px] font-black uppercase tracking-[0.14em] text-brand-teal">
                {t.scope.eyebrow}
              </p>
              <h2
                id="maintenance-scope-title"
                className="m-0 text-[clamp(28px,3.4vw,44px)] font-extrabold leading-[1.12]"
              >
                {t.scope.title}
              </h2>
            </div>
            <p className="m-0 text-[18px] leading-[1.7] text-steel">
              {t.scope.copy}
            </p>
          </div>
          <div className="grid gap-[18px] sm:grid-cols-2 lg:grid-cols-3">
            {t.scope.cards.map((card, i) => {
              const Icon = SCOPE_ICONS[i] ?? ShieldCheck;
              return (
                <article
                  key={card.title}
                  className="rounded-xl border border-line bg-white p-[26px]"
                >
                  <span className="inline-flex h-11 w-11 items-center justify-center rounded bg-muted-panel text-brand-teal">
                    <Icon aria-hidden="true" size={22} />
                  </span>
                  <h3 className="mt-4 text-2xl font-extrabold">{card.title}</h3>
                  <p className="mt-3 text-[17px] leading-[1.7] text-steel">
                    {card.copy}
                  </p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      {/* Operation care — dark photo bg (asset-07), copy + CTA / process steps */}
      <section
        aria-labelledby="maintenance-operation-title"
        className="relative py-[clamp(74px,10vw,128px)] text-white"
      >
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: "url('/sales/asset-07.jpg')" }}
        />
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-gradient-to-r from-ink/[0.92] to-ink/[0.78]"
        />
        <div className="relative z-[1] mx-auto grid max-w-[1240px] items-center gap-[42px] px-5 sm:px-8 lg:grid-cols-[0.85fr_1.15fr] lg:px-10">
          <div>
            <p className="m-0 mb-4 text-[13px] font-black uppercase tracking-[0.14em] text-signal">
              {t.operation.eyebrow}
            </p>
            <h2
              id="maintenance-operation-title"
              className="m-0 text-[clamp(28px,3.4vw,44px)] font-extrabold leading-[1.12]"
            >
              {t.operation.title}
            </h2>
            <p className="my-5 mb-[30px] text-[18px] leading-[1.7] text-white/85">
              {t.operation.copy}
            </p>
            <Link
              to={INTAKE_MAINTENANCE}
              className="inline-flex min-h-[54px] items-center justify-center gap-2.5 rounded bg-signal px-6 font-black text-ink transition-transform hover:bg-signal-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white motion-safe:hover:-translate-y-0.5"
            >
              {t.operation.cta}
              <ArrowRight aria-hidden="true" size={18} />
            </Link>
          </div>
          <div className="grid gap-3.5">
            {t.operation.steps.map((step) => (
              <article
                key={step.no}
                className="rounded-xl border border-white/15 bg-white/[0.08] p-6"
              >
                <span className="text-[13px] font-black uppercase tracking-[0.14em] text-signal">
                  {step.no}
                </span>
                <h3 className="my-2.5 text-[23px] font-extrabold">
                  {step.title}
                </h3>
                <p className="m-0 leading-[1.7] text-white/80">{step.copy}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* Repair contact band — signal/amber. Online intake first, phone last. */}
      <section
        aria-labelledby="maintenance-repair-title"
        className="bg-signal px-5 py-[clamp(40px,5vw,64px)] sm:px-8 lg:px-10"
      >
        <div className="mx-auto grid max-w-[1240px] items-center gap-[26px] lg:grid-cols-[1.3fr_auto_auto]">
          <div>
            <p className="m-0 mb-4 text-[13px] font-black uppercase tracking-[0.14em] text-ink/70">
              {t.repairContact.eyebrow}
            </p>
            <h2
              id="maintenance-repair-title"
              className="m-0 text-[clamp(28px,3.4vw,44px)] font-extrabold leading-[1.12]"
            >
              {t.repairContact.title}
            </h2>
          </div>
          <div className="grid gap-1">
            <span className="text-[13px] font-black text-ink/70">
              {t.repairContact.numberLabel}
            </span>
            <a
              href={t.repairContact.numberHref}
              className="text-xl font-extrabold text-ink underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              {t.repairContact.number}
            </a>
          </div>
          <Link
            to={INTAKE_MAINTENANCE}
            className="inline-flex min-h-[52px] items-center justify-center gap-2.5 rounded border border-ink bg-ink px-6 font-black text-white transition-transform focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink motion-safe:hover:-translate-y-0.5"
          >
            {t.repairContact.cta}
            <ArrowRight aria-hidden="true" size={18} />
          </Link>
        </div>
      </section>
    </main>
  );
}
