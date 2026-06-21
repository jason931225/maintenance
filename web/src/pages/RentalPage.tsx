import { type SyntheticEvent, useId, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";

import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Select } from "../components/ui/select";
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

/** Contact deep-link with the topic preselected for the inquiry form. */
const CONTACT_RENTAL = "/contact?topic=RENTAL";

/**
 * Rental page (#6 KNL). Routed child of PublicLayout — returns only its <main>.
 * Sections: page-hero, client-side Rental Finder (3 selects → recommendation
 * string + CTA), Why-Rental value cards, numbered process, contact band.
 */
export default function RentalPage() {
  const [type, setType] = useState<string>(TYPE_OPTIONS[0]);
  const [capacity, setCapacity] = useState<string>(CAPACITY_OPTIONS[0]);
  const [term, setTerm] = useState<string>(TERM_OPTIONS[0]);
  const [recommendation, setRecommendation] = useState<string | null>(null);

  const typeFieldId = useId();
  const capacityFieldId = useId();
  const termFieldId = useId();

  function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setRecommendation(
      [type, capacity, term].join(t.finder.resultSeparator) +
        t.finder.resultSuffix,
    );
  }

  return (
    <main className="flex-1">
      {/* Page hero */}
      <section
        className="relative flex min-h-[62svh] items-end bg-cover bg-center pt-[86px] text-white"
        style={{
          backgroundImage:
            "linear-gradient(90deg, rgba(5,13,20,0.88), rgba(5,13,20,0.58)), url('/sales/asset-04.jpg')",
        }}
        aria-label={t.hero.imageAlt}
      >
        <div className="mx-auto w-full max-w-[1240px] px-5 pb-14 pt-24 sm:px-8 lg:px-10 lg:pb-24 lg:pt-32">
          <p className="mb-4 text-[13px] font-black uppercase text-signal">
            {t.hero.eyebrow}
          </p>
          <h1 className="max-w-[820px] text-[clamp(2.375rem,6vw,4.5rem)] font-bold leading-[1.08]">
            {t.hero.title}
          </h1>
          <p className="mt-5 max-w-[720px] text-[clamp(1.0625rem,2vw,1.375rem)] leading-relaxed text-white/80">
            {t.hero.copy}
          </p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <Button
              asChild
              className="min-h-[54px] rounded bg-signal px-6 font-black text-ink hover:bg-signal-dark"
            >
              <Link to={CONTACT_RENTAL}>
                {t.hero.primary}
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </Button>
            <Button
              asChild
              variant="secondary"
              className="min-h-[54px] rounded border-white/40 bg-white/10 px-6 font-black text-white hover:bg-white/20"
            >
              <a href="#rental-process">{t.hero.secondary}</a>
            </Button>
          </div>
        </div>
      </section>

      {/* Rental Finder */}
      <section className="relative z-10 border-b border-line bg-white shadow-[0_22px_70px_rgba(5,18,32,0.18)]">
        <div className="mx-auto grid max-w-[1240px] items-end gap-7 px-5 py-8 sm:px-8 lg:grid-cols-[minmax(260px,0.8fr)_1.6fr] lg:px-10">
          <div>
            <p className="mb-2 text-[13px] font-black uppercase text-brand-teal">
              {t.finder.eyebrow}
            </p>
            <h2 className="text-[clamp(1.8125rem,4vw,3.25rem)] font-bold leading-[1.12]">
              {t.finder.title}
            </h2>
          </div>
          <form
            onSubmit={handleSubmit}
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            <label
              htmlFor={typeFieldId}
              className="grid gap-2 text-xs font-black uppercase text-steel"
            >
              {t.finder.typeLabel}
              <Select
                id={typeFieldId}
                value={type}
                onChange={(event) => {
                  setType(event.target.value);
                }}
                className="min-h-[54px]"
              >
                {TYPE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            </label>
            <label
              htmlFor={capacityFieldId}
              className="grid gap-2 text-xs font-black uppercase text-steel"
            >
              {t.finder.capacityLabel}
              <Select
                id={capacityFieldId}
                value={capacity}
                onChange={(event) => {
                  setCapacity(event.target.value);
                }}
                className="min-h-[54px]"
              >
                {CAPACITY_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            </label>
            <label
              htmlFor={termFieldId}
              className="grid gap-2 text-xs font-black uppercase text-steel"
            >
              {t.finder.termLabel}
              <Select
                id={termFieldId}
                value={term}
                onChange={(event) => {
                  setTerm(event.target.value);
                }}
                className="min-h-[54px]"
              >
                {TERM_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            </label>
            <Button
              type="submit"
              className="min-h-[54px] self-end rounded bg-ink font-black text-white hover:bg-ink/90"
            >
              {t.finder.submit}
            </Button>
          </form>
        </div>
        {recommendation && (
          <div className="bg-ink px-5 py-4 text-center sm:px-8 lg:px-10">
            <p className="m-0 font-extrabold text-white" role="status">
              {recommendation}
            </p>
            <Button
              asChild
              className="mt-3 rounded bg-signal font-black text-ink hover:bg-signal-dark"
            >
              <Link to={CONTACT_RENTAL}>
                {t.hero.primary}
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </Button>
          </div>
        )}
      </section>

      {/* Why Rental */}
      <section className="py-[clamp(4.625rem,10vw,8rem)]">
        <div className="mx-auto max-w-[1240px] px-5 sm:px-8 lg:px-10">
          <div className="mb-10 grid items-end gap-6 lg:grid-cols-[minmax(280px,0.75fr)_1fr]">
            <div>
              <p className="mb-2 text-[13px] font-black uppercase text-brand-teal">
                {t.why.eyebrow}
              </p>
              <h2 className="text-[clamp(1.8125rem,4vw,3.25rem)] font-bold leading-[1.12]">
                {t.why.title}
              </h2>
            </div>
            <p className="text-lg leading-relaxed text-steel">{t.why.copy}</p>
          </div>
          <div className="grid gap-[18px] md:grid-cols-3">
            {t.why.cards.map((card) => (
              <Card
                key={card.title}
                className="rounded-lg border-line p-[26px]"
              >
                <h3 className="m-0 text-2xl font-bold">{card.title}</h3>
                <p className="mt-3 text-[17px] leading-relaxed text-steel">
                  {card.copy}
                </p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Process */}
      <section
        id="rental-process"
        className="bg-muted-panel py-[clamp(4.625rem,10vw,8rem)]"
      >
        <div className="mx-auto max-w-[1240px] px-5 sm:px-8 lg:px-10">
          <div className="mb-10 max-w-[780px]">
            <p className="mb-2 text-[13px] font-black uppercase text-brand-teal">
              {t.process.eyebrow}
            </p>
            <h2 className="text-[clamp(1.8125rem,4vw,3.25rem)] font-bold leading-[1.12]">
              {t.process.title}
            </h2>
          </div>
          <div className="grid gap-[18px] sm:grid-cols-2 lg:grid-cols-4">
            {t.process.steps.map((step) => (
              <Card
                key={step.no}
                className="rounded-lg border-line p-[26px]"
              >
                <span className="text-[13px] font-black uppercase text-brand-teal">
                  {step.no}
                </span>
                <h3 className="mt-2 text-2xl font-bold">{step.title}</h3>
                <p className="mt-3 text-[17px] leading-relaxed text-steel">
                  {step.copy}
                </p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Contact band */}
      <section className="bg-signal py-[46px]">
        <div className="mx-auto grid max-w-[1240px] items-center gap-6 px-5 sm:px-8 lg:grid-cols-[1.3fr_auto_auto] lg:px-10">
          <div>
            <p className="mb-2 text-[13px] font-black uppercase text-ink/70">
              {t.contactBand.eyebrow}
            </p>
            <h2 className="m-0 text-[clamp(1.8125rem,4vw,3.25rem)] font-bold leading-[1.12]">
              {t.contactBand.title}
            </h2>
          </div>
          <div className="grid gap-1">
            <span className="text-[13px] font-black text-ink/70">
              {t.contactBand.numberLabel}
            </span>
            <a
              href="tel:07044430319"
              className="text-[clamp(1.5rem,3vw,2.25rem)] font-black text-ink"
            >
              {t.contactBand.number}
            </a>
          </div>
          <Button
            asChild
            className="min-h-[54px] rounded bg-ink px-6 font-black text-white hover:bg-ink/90"
          >
            <Link to={CONTACT_RENTAL}>{t.contactBand.cta}</Link>
          </Button>
        </div>
      </section>
    </main>
  );
}
