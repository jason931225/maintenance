import { type SyntheticEvent, useId, useMemo, useState } from "react";
import { CheckCircle2, Phone } from "lucide-react";
import { useSearchParams } from "react-router-dom";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import type { InquiryTopic } from "../api/types";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";

const TOPIC_VALUES = ["RENTAL", "USED_SALES", "MAINTENANCE", "OTHER"] as const;

function isTopic(value: string | null): value is InquiryTopic {
  return value !== null && (TOPIC_VALUES as readonly string[]).includes(value);
}

/**
 * Customer Center / inquiry page (#6 KNL — customer.html). Routed child of
 * PublicLayout, so it returns only its own <main>. Sections:
 *  - dark page hero (asset-07 + left gradient scrim)
 *  - two phone cards (sales 0319 / repair 0320)
 *  - online inquiry form -> POST /api/v1/storefront/inquiries (name/phone
 *    required, topic select, location, message); prefilled from ?listing= and
 *    ?topic=; shows success + error states
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

  function resetForm() {
    setName("");
    setPhone("");
    setTopic(initialTopic);
    setLocation("");
    setMessage("");
    setError(null);
    setStatus("idle");
  }

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedPhone = phone.trim();
    if (!trimmedName || !trimmedPhone) {
      setError(t.error.required);
      return;
    }

    setError(null);
    setStatus("submitting");

    const trimmedLocation = location.trim();
    const trimmedMessage = message.trim();
    const { error: apiError } = await api.POST(
      "/api/v1/storefront/inquiries",
      {
        body: {
          name: trimmedName,
          phone: trimmedPhone,
          topic,
          ...(trimmedLocation ? { location: trimmedLocation } : {}),
          ...(trimmedMessage ? { message: trimmedMessage } : {}),
          ...(listingId ? { listing_id: listingId } : {}),
        },
      },
    );

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
      {/* Hero */}
      <section
        className="relative flex min-h-[58vh] items-end bg-cover bg-center text-white"
        style={{ backgroundImage: "url('/sales/asset-07.jpg')" }}
      >
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-gradient-to-r from-[#050d14]/90 to-[#050d14]/55"
        />
        <div className="relative mx-auto w-full max-w-[1240px] px-5 pb-16 pt-28 sm:px-8 lg:px-12">
          <p className="mb-4 text-[13px] font-black uppercase tracking-wide text-signal">
            {t.hero.eyebrow}
          </p>
          <h1 className="m-0 max-w-[820px] text-4xl font-black leading-[1.08] sm:text-5xl lg:text-6xl">
            {t.hero.title}
          </h1>
          <p className="mt-5 max-w-[720px] text-lg leading-relaxed text-white/80">
            {t.hero.copy}
          </p>
        </div>
      </section>

      {/* Phone cards */}
      <section className="px-5 py-16 sm:px-8 sm:py-20 lg:px-12 lg:py-24">
        <div className="mx-auto grid max-w-[1240px] gap-5 sm:grid-cols-2">
          {[t.cards.sales, t.cards.repair].map((card) => (
            <article
              key={card.numberHref}
              className="rounded-lg border border-line bg-white p-7"
            >
              <span className="text-[13px] font-black uppercase text-brand-teal">
                {card.label}
              </span>
              <a
                href={card.numberHref}
                className="mt-2.5 flex items-center gap-3 text-3xl font-black leading-tight text-ink sm:text-4xl"
              >
                <Phone aria-hidden="true" className="h-7 w-7 text-signal-dark" />
                {card.number}
              </a>
              <p className="mt-3 text-base leading-relaxed text-steel">
                {card.copy}
              </p>
            </article>
          ))}
        </div>
      </section>

      {/* Online inquiry */}
      <section
        id="quick-inquiry"
        className="bg-muted-panel px-5 py-16 sm:px-8 sm:py-20 lg:px-12 lg:py-24"
      >
        <div className="mx-auto grid max-w-[1240px] items-start gap-9 lg:grid-cols-[0.75fr_1.25fr]">
          <div>
            <p className="mb-4 text-[13px] font-black uppercase text-brand-teal">
              {t.form.eyebrow}
            </p>
            <h2 className="m-0 text-3xl font-black leading-tight sm:text-4xl">
              {t.form.title}
            </h2>
            <p className="mt-4 text-lg leading-relaxed text-steel">
              {t.form.copy}
            </p>
          </div>

          {status === "success" ? (
            <div className="grid content-start gap-4 rounded-lg border border-line bg-white p-7">
              <CheckCircle2
                aria-hidden="true"
                className="h-12 w-12 text-brand-teal"
              />
              <h3 className="m-0 text-2xl font-black">{t.success.title}</h3>
              <p className="m-0 text-base leading-relaxed text-steel">
                {t.success.copy}
              </p>
              <Button
                type="button"
                variant="secondary"
                className="mt-2 w-fit"
                onClick={resetForm}
              >
                {t.success.again}
              </Button>
            </div>
          ) : (
            <form
              noValidate
              onSubmit={(event) => {
                void handleSubmit(event);
              }}
              className="grid gap-3.5 rounded-lg border border-line bg-white p-7 sm:grid-cols-2"
            >
              <label
                htmlFor={`${fieldId}-name`}
                className="grid gap-2 text-xs font-black uppercase text-steel"
              >
                {t.form.nameLabel}
                <Input
                  id={`${fieldId}-name`}
                  name="name"
                  type="text"
                  required
                  autoComplete="name"
                  placeholder={t.form.namePlaceholder}
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                />
              </label>

              <label
                htmlFor={`${fieldId}-phone`}
                className="grid gap-2 text-xs font-black uppercase text-steel"
              >
                {t.form.phoneLabel}
                <Input
                  id={`${fieldId}-phone`}
                  name="phone"
                  type="tel"
                  required
                  autoComplete="tel"
                  placeholder={t.form.phonePlaceholder}
                  value={phone}
                  onChange={(event) => {
                    setPhone(event.target.value);
                  }}
                />
              </label>

              <label
                htmlFor={`${fieldId}-topic`}
                className="grid gap-2 text-xs font-black uppercase text-steel"
              >
                {t.form.topicLabel}
                <Select
                  id={`${fieldId}-topic`}
                  name="topic"
                  value={topic}
                  onChange={(event) => {
                    setTopic(event.target.value as InquiryTopic);
                  }}
                >
                  {TOPIC_VALUES.map((value) => (
                    <option key={value} value={value}>
                      {t.form.topicOptions[value]}
                    </option>
                  ))}
                </Select>
              </label>

              <label
                htmlFor={`${fieldId}-location`}
                className="grid gap-2 text-xs font-black uppercase text-steel"
              >
                {t.form.locationLabel}
                <Input
                  id={`${fieldId}-location`}
                  name="location"
                  type="text"
                  placeholder={t.form.locationPlaceholder}
                  value={location}
                  onChange={(event) => {
                    setLocation(event.target.value);
                  }}
                />
              </label>

              <label
                htmlFor={`${fieldId}-message`}
                className="grid gap-2 text-xs font-black uppercase text-steel sm:col-span-2"
              >
                {t.form.messageLabel}
                <Textarea
                  id={`${fieldId}-message`}
                  name="message"
                  rows={4}
                  placeholder={t.form.messagePlaceholder}
                  value={message}
                  onChange={(event) => {
                    setMessage(event.target.value);
                  }}
                />
              </label>

              {error ? (
                <p
                  role="alert"
                  className="m-0 text-sm font-semibold text-red-700 sm:col-span-2"
                >
                  {error}
                </p>
              ) : null}

              <Button
                type="submit"
                disabled={submitting}
                className="bg-ink text-white hover:bg-ink/90 sm:col-span-2"
              >
                {submitting ? t.form.submitting : t.form.submit}
              </Button>
            </form>
          )}
        </div>
      </section>

      {/* FAQ */}
      <section className="px-5 py-16 sm:px-8 sm:py-20 lg:px-12 lg:py-24">
        <div className="mx-auto grid max-w-[1240px] items-start gap-10 lg:grid-cols-[0.7fr_1fr]">
          <div>
            <p className="mb-4 text-[13px] font-black uppercase text-brand-teal">
              {t.faq.eyebrow}
            </p>
            <h2 className="m-0 text-3xl font-black leading-tight sm:text-4xl lg:text-5xl">
              {t.faq.title}
            </h2>
          </div>
          <div className="grid gap-3">
            {t.faq.items.map((item, index) => (
              <details
                key={item.q}
                open={index === 0}
                className="rounded-lg border border-line bg-white p-6 [&_summary]:cursor-pointer"
              >
                <summary className="text-lg font-black marker:text-signal-dark">
                  {item.q}
                </summary>
                <p className="mt-3 text-base leading-relaxed text-steel">
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
