import { Link } from "react-router-dom";
import { ShieldCheck, Siren, ClipboardCheck, ArrowRight } from "lucide-react";

import { Button } from "../components/ui/button";
import { ko } from "../i18n/ko";

const SCOPE_ICONS = [ShieldCheck, Siren, ClipboardCheck] as const;

/**
 * Maintenance page (#6 KNL). Routed child of PublicLayout — returns only its
 * <main>. Mirrors maintenance.html: page-hero (asset-05), service-scope cards,
 * operation-care section (asset-07 dark photo) and a repair contact band on the
 * 070.4443.0320 repair line. All copy from ko.storefront.maintenance.*.
 */
export default function MaintenancePage() {
  const t = ko.storefront.maintenance;

  return (
    <main className="flex-1">
      {/* Page hero — dark photo with left gradient scrim (asset-05) */}
      <section className="relative grid min-h-[62svh] items-end pt-[86px] text-white">
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: "url('/sales/asset-05.jpg')" }}
        />
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-gradient-to-r from-[#050d14]/[0.88] to-[#050d14]/[0.58]"
        />
        <div className="relative z-[1] mx-auto w-full max-w-[1240px] px-5 pb-[clamp(54px,8vw,96px)] pt-[clamp(80px,12vw,140px)] sm:px-8 lg:px-10">
          <p className="m-0 mb-4 text-[13px] font-black uppercase text-signal">
            {t.hero.eyebrow}
          </p>
          <h1 className="m-0 max-w-[820px] text-[clamp(38px,6vw,72px)] font-extrabold leading-[1.08]">
            {t.hero.title}
          </h1>
          <p className="mt-[22px] max-w-[720px] text-[clamp(17px,2vw,22px)] leading-[1.65] text-white/80">
            {t.hero.copy}
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Button
              asChild
              className="min-h-[54px] rounded bg-signal px-6 text-[#14120c] hover:bg-signal hover:-translate-y-0.5 hover:bg-signal-dark"
            >
              <Link to="/contact">
                {t.hero.primary}
                <ArrowRight aria-hidden="true" size={18} />
              </Link>
            </Button>
            <Button
              asChild
              className="min-h-[54px] rounded border border-white/35 bg-white/10 px-6 text-white hover:-translate-y-0.5 hover:bg-white/20"
            >
              <a href="#service-scope">{t.hero.secondary}</a>
            </Button>
          </div>
        </div>
      </section>

      {/* Service scope — split heading + 3 info cards */}
      <section
        id="service-scope"
        className="scroll-mt-[86px] py-[clamp(74px,10vw,128px)]"
      >
        <div className="mx-auto max-w-[1240px] px-5 sm:px-8 lg:px-10">
          <div className="mb-10 grid items-end gap-6 md:grid-cols-[minmax(280px,0.75fr)_1fr]">
            <div>
              <p className="m-0 mb-4 text-[13px] font-black uppercase text-brand-teal">
                {t.scope.eyebrow}
              </p>
              <h2 className="m-0 text-[clamp(29px,4vw,52px)] font-extrabold leading-[1.12]">
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
                  className="rounded-lg border border-line bg-white p-[26px]"
                >
                  <span className="inline-flex h-11 w-11 items-center justify-center rounded bg-muted-panel text-brand-teal">
                    <Icon aria-hidden="true" size={22} />
                  </span>
                  <h3 className="mt-4 text-2xl font-bold">{card.title}</h3>
                  <p className="mt-3 text-[17px] leading-[1.65] text-steel">
                    {card.copy}
                  </p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      {/* Operation care — dark photo bg (asset-07), copy + light CTA / process steps */}
      <section className="relative py-[clamp(74px,10vw,128px)] text-white">
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: "url('/sales/asset-07.jpg')" }}
        />
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-gradient-to-r from-[#08121a]/[0.92] to-[#08121a]/[0.78]"
        />
        <div className="relative z-[1] mx-auto grid max-w-[1240px] items-center gap-[42px] px-5 sm:px-8 lg:grid-cols-[0.85fr_1.15fr] lg:px-10">
          <div>
            <p className="m-0 mb-4 text-[13px] font-black uppercase text-signal">
              {t.operation.eyebrow}
            </p>
            <h2 className="m-0 text-[clamp(29px,4vw,52px)] font-extrabold leading-[1.12]">
              {t.operation.title}
            </h2>
            <p className="my-5 mb-[30px] text-[18px] leading-[1.7] text-white/[0.78]">
              {t.operation.copy}
            </p>
            <Button
              asChild
              className="min-h-[54px] rounded border border-white/35 bg-white/[0.12] px-6 text-white hover:-translate-y-0.5 hover:bg-white/20"
            >
              <Link to="/contact">{t.operation.cta}</Link>
            </Button>
          </div>
          <div className="grid gap-3.5">
            {t.operation.steps.map((step) => (
              <article
                key={step.no}
                className="rounded-lg border border-white/15 bg-white/[0.08] p-6"
              >
                <span className="text-[13px] font-black uppercase text-signal">
                  {step.no}
                </span>
                <h3 className="my-2.5 text-[23px] font-bold">{step.title}</h3>
                <p className="m-0 leading-[1.65] text-white/75">{step.copy}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* Repair contact band — signal/amber, repair line 070.4443.0320 */}
      <section className="bg-signal py-[46px]">
        <div className="mx-auto grid max-w-[1240px] items-center gap-[26px] px-5 sm:px-8 lg:grid-cols-[1.3fr_auto_auto] lg:px-10">
          <div>
            <p className="m-0 mb-4 text-[13px] font-black uppercase text-ink/[0.68]">
              {t.repairContact.eyebrow}
            </p>
            <h2 className="m-0 text-[clamp(29px,4vw,52px)] font-extrabold leading-[1.12]">
              {t.repairContact.title}
            </h2>
          </div>
          <div className="grid gap-1">
            <span className="text-[13px] font-black text-ink/[0.68]">
              {t.repairContact.numberLabel}
            </span>
            <a
              href={t.repairContact.numberHref}
              className="text-[clamp(24px,3vw,36px)] font-black"
            >
              {t.repairContact.number}
            </a>
          </div>
          <Button
            asChild
            className="min-h-[54px] rounded bg-ink px-6 text-white hover:-translate-y-0.5 hover:bg-ink"
          >
            <Link to="/contact">{t.repairContact.cta}</Link>
          </Button>
        </div>
      </section>
    </main>
  );
}
