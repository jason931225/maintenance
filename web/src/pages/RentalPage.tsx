import { type SyntheticEvent, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, ChevronRight } from "lucide-react";

import { ko } from "../i18n/ko";

const t = ko.storefront.rental;

const TYPE_OPTIONS = [
  t.finder.typeOptions.electric,
  t.finder.typeOptions.diesel,
  t.finder.typeOptions.lpg,
  t.finder.typeOptions.reach,
] as const;

const CAPACITY_OPTIONS = [
  t.finder.capacityOptions.under15,
  t.finder.capacityOptions.to25,
  t.finder.capacityOptions.to35,
  t.finder.capacityOptions.over4,
] as const;

const TERM_OPTIONS = [
  t.finder.termOptions.under1m,
  t.finder.termOptions.to6m,
  t.finder.termOptions.to12m,
  t.finder.termOptions.over1y,
] as const;

// Sales/rental leads belong in the storefront inquiry inbox, not the maintenance
// support-ticket queue. Maintenance CTAs still use /support/new.
const INQUIRY_RENTAL = "/contact?topic=RENTAL";

const SELECT_CLASS =
  "min-h-[54px] w-full rounded border border-line bg-white px-3.5 text-[16px] font-bold text-ink outline-none transition-colors focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

/**
 * Rental page (#6 KNL). Routed child of PublicLayout — returns only its <main>.
 * Sections: page-hero, client-side Rental Finder (3 selects → recommendation
 * string + CTA), Why-Rental value cards, numbered process, contact band. The
 * dominant CTA routes to the online intake (/support/new); phone is last resort.
 */
export default function RentalPage() {
  const [type, setType] = useState<string>(TYPE_OPTIONS[0]);
  const [capacity, setCapacity] = useState<string>(CAPACITY_OPTIONS[0]);
  const [term, setTerm] = useState<string>(TERM_OPTIONS[0]);
  const [recommendation, setRecommendation] = useState<string | null>(null);

  const typeFieldId = useId();
  const capacityFieldId = useId();
  const termFieldId = useId();
  const resultRef = useRef<HTMLDivElement>(null);

  function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setRecommendation(
      [type, capacity, term].join(t.finder.resultSeparator) +
        t.finder.resultSuffix,
    );
    // Move focus to the recommendation so the result is announced and reachable.
    void Promise.resolve().then(() => resultRef.current?.focus());
  }

  return (
    <main className="flex-1">
      {/* Page hero — decorative photo background. */}
      <section
        aria-labelledby="rental-hero-title"
        className="relative flex min-h-[62svh] items-end bg-cover bg-center text-white"
        style={{
          backgroundImage:
            "linear-gradient(90deg, rgba(16,24,32,0.88), rgba(16,24,32,0.58)), url('/sales/asset-04.jpg')",
        }}
      >
        <div className="mx-auto w-full max-w-[1240px] px-5 pb-14 pt-[clamp(110px,14vw,150px)] sm:px-8 lg:px-10">
          <p className="mb-4 text-[13px] font-black uppercase tracking-[0.14em] text-signal">
            {t.hero.eyebrow}
          </p>
          <h1
            id="rental-hero-title"
            className="balance-text m-0 max-w-[820px] text-[clamp(38px,6vw,72px)] font-extrabold leading-[1.08] tracking-[-0.02em]"
          >
            {t.hero.title}
          </h1>
          <p className="mt-5 max-w-[720px] text-[clamp(17px,2vw,22px)] leading-[1.7] text-white/85">
            {t.hero.copy}
          </p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <Link
              to={INQUIRY_RENTAL}
              className="inline-flex min-h-[54px] items-center justify-center gap-2.5 rounded bg-signal px-6 font-black text-ink transition-transform focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white motion-safe:hover:-translate-y-0.5"
            >
              {t.hero.primary}
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Link>
            <a
              href="#rental-process"
              className="inline-flex min-h-[54px] items-center justify-center rounded border border-white/40 bg-white/10 px-6 font-black text-white transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              {t.hero.secondary}
            </a>
          </div>
        </div>
      </section>

      {/* Rental Finder */}
      <section
        aria-labelledby="rental-finder-title"
        className="relative z-10 border-b border-line bg-white shadow-[0_22px_70px_rgba(5,18,32,0.18)]"
      >
        <div className="mx-auto grid max-w-[1240px] items-end gap-7 px-5 py-8 sm:px-8 lg:grid-cols-[minmax(260px,0.8fr)_1.6fr] lg:px-10">
          <div>
            <p className="mb-2 text-[13px] font-black uppercase tracking-[0.14em] text-brand-teal">
              {t.finder.eyebrow}
            </p>
            <h2
              id="rental-finder-title"
              className="m-0 text-[clamp(28px,3.4vw,44px)] font-extrabold leading-[1.12]"
            >
              {t.finder.title}
            </h2>
          </div>
          <form
            onSubmit={handleSubmit}
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            <label
              htmlFor={typeFieldId}
              className="grid gap-2 text-[12px] font-black uppercase tracking-[0.08em] text-steel"
            >
              {t.finder.typeLabel}
              <select
                id={typeFieldId}
                value={type}
                onChange={(event) => {
                  setType(event.target.value);
                }}
                className={SELECT_CLASS}
              >
                {TYPE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label
              htmlFor={capacityFieldId}
              className="grid gap-2 text-[12px] font-black uppercase tracking-[0.08em] text-steel"
            >
              {t.finder.capacityLabel}
              <select
                id={capacityFieldId}
                value={capacity}
                onChange={(event) => {
                  setCapacity(event.target.value);
                }}
                className={SELECT_CLASS}
              >
                {CAPACITY_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label
              htmlFor={termFieldId}
              className="grid gap-2 text-[12px] font-black uppercase tracking-[0.08em] text-steel"
            >
              {t.finder.termLabel}
              <select
                id={termFieldId}
                value={term}
                onChange={(event) => {
                  setTerm(event.target.value);
                }}
                className={SELECT_CLASS}
              >
                {TERM_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="min-h-[54px] self-end rounded bg-ink px-4 font-black text-white transition-colors hover:bg-ink/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              {t.finder.submit}
            </button>
          </form>
        </div>
        {recommendation ? (
          <div className="bg-ink px-5 py-5 text-center sm:px-8 lg:px-10">
            <p
              ref={resultRef}
              tabIndex={-1}
              role="status"
              className="m-0 font-extrabold text-white outline-none"
            >
              {recommendation}
            </p>
            <Link
              to={INQUIRY_RENTAL}
              className="mt-3 inline-flex min-h-[48px] items-center justify-center gap-2 rounded bg-signal px-6 font-black text-ink transition-transform focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white motion-safe:hover:-translate-y-0.5"
            >
              {t.hero.primary}
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
        ) : null}
      </section>

      {/* Why Rental */}
      <section
        aria-labelledby="rental-why-title"
        className="py-[clamp(74px,10vw,128px)]"
      >
        <div className="mx-auto max-w-[1240px] px-5 sm:px-8 lg:px-10">
          <div className="mb-10 grid items-end gap-6 lg:grid-cols-[minmax(280px,0.75fr)_1fr]">
            <div>
              <p className="mb-2 text-[13px] font-black uppercase tracking-[0.14em] text-brand-teal">
                {t.why.eyebrow}
              </p>
              <h2
                id="rental-why-title"
                className="m-0 text-[clamp(28px,3.4vw,44px)] font-extrabold leading-[1.12]"
              >
                {t.why.title}
              </h2>
            </div>
            <p className="m-0 text-[18px] leading-[1.7] text-steel">
              {t.why.copy}
            </p>
          </div>
          <div className="grid gap-[18px] md:grid-cols-3">
            {t.why.cards.map((card) => (
              <article
                key={card.title}
                className="rounded-xl border border-line bg-white p-[26px]"
              >
                <h3 className="m-0 text-2xl font-extrabold">{card.title}</h3>
                <p className="mt-3 text-[17px] leading-[1.7] text-steel">
                  {card.copy}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* Process */}
      <section
        id="rental-process"
        aria-labelledby="rental-process-title"
        className="scroll-mt-[86px] bg-muted-panel py-[clamp(74px,10vw,128px)]"
      >
        <div className="mx-auto max-w-[1240px] px-5 sm:px-8 lg:px-10">
          <div className="mb-10 max-w-[780px]">
            <p className="mb-2 text-[13px] font-black uppercase tracking-[0.14em] text-brand-teal">
              {t.process.eyebrow}
            </p>
            <h2
              id="rental-process-title"
              className="m-0 text-[clamp(28px,3.4vw,44px)] font-extrabold leading-[1.12]"
            >
              {t.process.title}
            </h2>
          </div>
          <div className="grid gap-[18px] sm:grid-cols-2 lg:grid-cols-4">
            {t.process.steps.map((step) => (
              <article
                key={step.no}
                className="rounded-xl border border-line bg-white p-[26px]"
              >
                <span className="text-[13px] font-black uppercase tracking-[0.14em] text-brand-teal">
                  {step.no}
                </span>
                <h3 className="mt-2 text-2xl font-extrabold">{step.title}</h3>
                <p className="mt-3 text-[17px] leading-[1.7] text-steel">
                  {step.copy}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* Contact band — online intake first, phone last resort. */}
      <section
        aria-labelledby="rental-contact-title"
        className="bg-signal px-5 py-[clamp(40px,5vw,64px)] sm:px-8 lg:px-10"
      >
        <div className="mx-auto grid max-w-[1240px] items-center gap-6 lg:grid-cols-[1.3fr_auto_auto]">
          <div>
            <p className="mb-2 text-[13px] font-black uppercase tracking-[0.14em] text-ink/70">
              {t.contactBand.eyebrow}
            </p>
            <h2
              id="rental-contact-title"
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
              className="text-xl font-extrabold text-ink underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              {t.contactBand.number}
            </a>
          </div>
          <Link
            to={INQUIRY_RENTAL}
            className="inline-flex min-h-[52px] items-center justify-center gap-2.5 rounded border border-ink bg-ink px-6 font-black text-white transition-transform focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink motion-safe:hover:-translate-y-0.5"
          >
            {t.contactBand.cta}
            <ArrowRight aria-hidden="true" size={18} />
          </Link>
        </div>
      </section>
    </main>
  );
}
