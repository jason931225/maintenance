import { type SyntheticEvent, useId, useMemo, useRef, useState } from "react";
import { CheckCircle2, Phone } from "lucide-react";
import { useSearchParams } from "react-router-dom";

import type { InquiryTopic } from "../api/types";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";

const TOPIC_VALUES = ["RENTAL", "USED_SALES", "MAINTENANCE", "OTHER"] as const;

function isTopic(value: string | null): value is InquiryTopic {
  return value !== null && (TOPIC_VALUES as readonly string[]).includes(value);
}

const FIELD_CLASS =
  "min-h-[48px] w-full rounded border border-line bg-white px-3.5 text-[16px] font-medium text-ink outline-none transition-colors focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink aria-invalid:border-red-600";

/**
 * Customer Center / inquiry page (#6 KNL — customer.html). Routed child of
 * PublicLayout, so it returns only its own <main>. Sections:
 *  - dark page hero (asset-07 + left gradient scrim)
 *  - two phone cards (sales 0319 / repair 0320)
 *  - online inquiry form -> POST /api/v1/storefront/inquiries (name/phone
 *    required, topic select, location, message); prefilled from ?listing= and
 *    ?topic=; shows success + error states with per-field validation
 *  - FAQ accordion (split panel)
 * All Korean copy comes from ko.storefront.contact.*.
 */
export default function ContactPage() {
  const t = ko.storefront.contact;
  const { api } = useAuth();
  const [searchParams] = useSearchParams();
  const fieldId = useId();

  const listingId = searchParams.get("listing");
  const initialTopic = useMemo<InquiryTopic>(() => {
    const param = searchParams.get("topic");
    return isTopic(param) ? param : "RENTAL";
  }, [searchParams]);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [topic, setTopic] = useState<InquiryTopic>(initialTopic);
  const [location, setLocation] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "success">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<{ name: boolean; phone: boolean }>({
    name: false,
    phone: false,
  });

  const nameRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);

  function resetForm() {
    setName("");
    setPhone("");
    setTopic(initialTopic);
    setLocation("");
    setMessage("");
    setError(null);
    setInvalid({ name: false, phone: false });
    setStatus("idle");
  }

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedPhone = phone.trim();
    const nextInvalid = { name: !trimmedName, phone: !trimmedPhone };
    if (nextInvalid.name || nextInvalid.phone) {
      setInvalid(nextInvalid);
      setError(t.error.required);
      // Move focus to the first invalid field so the error is announced.
      if (nextInvalid.name) nameRef.current?.focus();
      else phoneRef.current?.focus();
      return;
    }

    setInvalid({ name: false, phone: false });
    setError(null);
    setStatus("submitting");

    const trimmedLocation = location.trim();
    const trimmedMessage = message.trim();
    // A thrown network error (offline, DNS, CORS) must not leave the form stuck
    // in "submitting"; treat it as a failure like any non-2xx response.
    const { error: apiError } = await api
      .POST("/api/v1/storefront/inquiries", {
        body: {
          name: trimmedName,
          phone: trimmedPhone,
          topic,
          ...(trimmedLocation ? { location: trimmedLocation } : {}),
          ...(trimmedMessage ? { message: trimmedMessage } : {}),
          ...(listingId ? { listing_id: listingId } : {}),
        },
      })
      .catch(() => ({ error: true }) as const);

    if (apiError) {
      setError(t.error.failed);
      setStatus("idle");
      return;
    }

    setStatus("success");
  }

  const submitting = status === "submitting";

  return (
    <main className="flex-1">
      {/* Hero — decorative photo background. */}
      <section
        aria-labelledby="contact-hero-title"
        className="relative flex min-h-[58vh] items-end bg-cover bg-center text-white"
        style={{ backgroundImage: "url('/sales/asset-07.jpg')" }}
      >
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-gradient-to-r from-ink/90 to-ink/55"
        />
        <div className="relative mx-auto w-full max-w-[1240px] px-5 pb-16 pt-28 sm:px-8 lg:px-12">
          <p className="mb-4 text-[13px] font-black uppercase tracking-[0.14em] text-signal">
            {t.hero.eyebrow}
          </p>
          <h1
            id="contact-hero-title"
            className="balance-text m-0 max-w-[820px] text-[clamp(38px,6vw,72px)] font-extrabold leading-[1.08] tracking-[-0.02em]"
          >
            {t.hero.title}
          </h1>
          <p className="mt-5 max-w-[720px] text-[clamp(17px,2vw,22px)] leading-[1.7] text-white/85">
            {t.hero.copy}
          </p>
        </div>
      </section>

      {/* Phone cards */}
      <section
        aria-labelledby="contact-phone-title"
        className="px-5 py-16 sm:px-8 sm:py-20 lg:px-12 lg:py-24"
      >
        <h2 id="contact-phone-title" className="sr-only">
          {t.hero.eyebrow}
        </h2>
        <div className="mx-auto grid max-w-[1240px] gap-5 sm:grid-cols-2">
          {[t.cards.sales, t.cards.repair].map((card) => (
            <article
              key={card.numberHref}
              className="rounded-xl border border-line bg-white p-7"
            >
              <span className="text-[13px] font-black uppercase tracking-[0.14em] text-brand-teal">
                {card.label}
              </span>
              <a
                href={card.numberHref}
                className="mt-2.5 flex items-center gap-3 text-3xl font-extrabold leading-tight text-ink underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink sm:text-4xl"
              >
                <Phone aria-hidden="true" className="h-7 w-7 text-signal-dark" />
                {card.number}
              </a>
              <p className="mt-3 text-[17px] leading-[1.7] text-steel">
                {card.copy}
              </p>
            </article>
          ))}
        </div>
      </section>

      {/* Online inquiry */}
      <section
        id="quick-inquiry"
        aria-labelledby="contact-form-title"
        className="bg-muted-panel px-5 py-16 sm:px-8 sm:py-20 lg:px-12 lg:py-24"
      >
        <div className="mx-auto grid max-w-[1240px] items-start gap-9 lg:grid-cols-[0.75fr_1.25fr]">
          <div>
            <p className="mb-4 text-[13px] font-black uppercase tracking-[0.14em] text-brand-teal">
              {t.form.eyebrow}
            </p>
            <h2
              id="contact-form-title"
              className="m-0 text-[clamp(28px,3.4vw,44px)] font-extrabold leading-[1.12]"
            >
              {t.form.title}
            </h2>
            <p className="mt-4 text-[18px] leading-[1.7] text-steel">
              {t.form.copy}
            </p>
          </div>

          {status === "success" ? (
            <div className="grid content-start gap-4 rounded-xl border border-line bg-white p-7">
              <CheckCircle2
                aria-hidden="true"
                className="h-12 w-12 text-brand-teal"
              />
              <h3 className="m-0 text-2xl font-extrabold" role="status">
                {t.success.title}
              </h3>
              <p className="m-0 text-[17px] leading-[1.7] text-steel">
                {t.success.copy}
              </p>
              <button
                type="button"
                onClick={resetForm}
                className="mt-2 inline-flex min-h-[48px] w-fit items-center justify-center rounded border border-line bg-white px-6 font-bold text-ink transition-colors hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                {t.success.again}
              </button>
            </div>
          ) : (
            <form
              noValidate
              onSubmit={(event) => {
                void handleSubmit(event);
              }}
              className="grid gap-3.5 rounded-xl border border-line bg-white p-7 sm:grid-cols-2"
            >
              {listingId ? (
                <p className="m-0 rounded-lg border border-brand-teal/30 bg-brand-teal/10 px-4 py-3 text-sm font-bold leading-6 text-brand-teal sm:col-span-2">
                  {t.form.listingContext.replace("{listingId}", listingId)}
                </p>
              ) : null}

              <label
                htmlFor={`${fieldId}-name`}
                className="grid gap-2 text-[12px] font-black uppercase tracking-[0.08em] text-steel"
              >
                {t.form.nameLabel}
                <input
                  id={`${fieldId}-name`}
                  ref={nameRef}
                  name="name"
                  type="text"
                  required
                  autoComplete="name"
                  placeholder={t.form.namePlaceholder}
                  value={name}
                  aria-invalid={invalid.name}
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                  className={FIELD_CLASS}
                />
              </label>

              <label
                htmlFor={`${fieldId}-phone`}
                className="grid gap-2 text-[12px] font-black uppercase tracking-[0.08em] text-steel"
              >
                {t.form.phoneLabel}
                <input
                  id={`${fieldId}-phone`}
                  ref={phoneRef}
                  name="phone"
                  type="tel"
                  required
                  autoComplete="tel"
                  placeholder={t.form.phonePlaceholder}
                  value={phone}
                  aria-invalid={invalid.phone}
                  onChange={(event) => {
                    setPhone(event.target.value);
                  }}
                  className={FIELD_CLASS}
                />
              </label>

              <label
                htmlFor={`${fieldId}-topic`}
                className="grid gap-2 text-[12px] font-black uppercase tracking-[0.08em] text-steel"
              >
                {t.form.topicLabel}
                <select
                  id={`${fieldId}-topic`}
                  name="topic"
                  value={topic}
                  onChange={(event) => {
                    setTopic(event.target.value as InquiryTopic);
                  }}
                  className={FIELD_CLASS}
                >
                  {TOPIC_VALUES.map((value) => (
                    <option key={value} value={value}>
                      {t.form.topicOptions[value]}
                    </option>
                  ))}
                </select>
              </label>

              <label
                htmlFor={`${fieldId}-location`}
                className="grid gap-2 text-[12px] font-black uppercase tracking-[0.08em] text-steel"
              >
                {t.form.locationLabel}
                <input
                  id={`${fieldId}-location`}
                  name="location"
                  type="text"
                  placeholder={t.form.locationPlaceholder}
                  value={location}
                  onChange={(event) => {
                    setLocation(event.target.value);
                  }}
                  className={FIELD_CLASS}
                />
              </label>

              <label
                htmlFor={`${fieldId}-message`}
                className="grid gap-2 text-[12px] font-black uppercase tracking-[0.08em] text-steel sm:col-span-2"
              >
                {t.form.messageLabel}
                <textarea
                  id={`${fieldId}-message`}
                  name="message"
                  rows={4}
                  placeholder={t.form.messagePlaceholder}
                  value={message}
                  onChange={(event) => {
                    setMessage(event.target.value);
                  }}
                  className={`${FIELD_CLASS} min-h-[120px] py-3 leading-[1.6]`}
                />
              </label>

              {error ? (
                <p
                  role="alert"
                  className="m-0 text-[14px] font-bold text-red-700 sm:col-span-2"
                >
                  {error}
                </p>
              ) : null}

              <button
                type="submit"
                disabled={submitting}
                className="inline-flex min-h-[52px] items-center justify-center rounded bg-ink px-6 font-black text-white transition-colors hover:bg-ink/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-60 sm:col-span-2"
              >
                {submitting ? t.form.submitting : t.form.submit}
              </button>
            </form>
          )}
        </div>
      </section>

      {/* FAQ */}
      <section
        aria-labelledby="contact-faq-title"
        className="px-5 py-16 sm:px-8 sm:py-20 lg:px-12 lg:py-24"
      >
        <div className="mx-auto grid max-w-[1240px] items-start gap-10 lg:grid-cols-[0.7fr_1fr]">
          <div>
            <p className="mb-4 text-[13px] font-black uppercase tracking-[0.14em] text-brand-teal">
              {t.faq.eyebrow}
            </p>
            <h2
              id="contact-faq-title"
              className="m-0 text-[clamp(28px,3.4vw,44px)] font-extrabold leading-[1.12]"
            >
              {t.faq.title}
            </h2>
          </div>
          <div className="grid gap-3">
            {t.faq.items.map((item, index) => (
              <details
                key={item.q}
                open={index === 0}
                className="rounded-xl border border-line bg-white p-6"
              >
                <summary className="cursor-pointer rounded text-lg font-extrabold marker:text-signal-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
                  {item.q}
                </summary>
                <p className="mt-3 text-[17px] leading-[1.7] text-steel">
                  {item.a}
                </p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
