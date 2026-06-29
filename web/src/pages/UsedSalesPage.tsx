import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Check, Loader2, RotateCw } from "lucide-react";
import { Link } from "react-router-dom";

import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";
import { cn } from "../lib/utils";
import type {
  ListingCondition,
  ListingKind,
  SalesListingView,
} from "../api/types";

/**
 * Used-sales catalog page (#6 KNL). Routed child of PublicLayout — returns only
 * its <main>. Data-backed: on mount (and on filter change) it pulls the public
 * storefront listings and renders each as an equipment card with an inquiry CTA
 * that deep-links into the online intake (/support/new?listing={id}&topic=USED_SALES).
 * All copy comes from ko.storefront.used.*.
 */

// Used/new sub-category tabs for the Sales category split.
// `condition: null` is the "all" tab; drives the storefront `condition` filter.
const CONDITIONS: ReadonlyArray<{
  key: string;
  label: string;
  condition: ListingCondition | null;
}> = [
  { key: "all", label: ko.storefront.used.filters.all, condition: null },
  { key: "used", label: ko.storefront.used.conditions.used, condition: "USED" },
  { key: "new", label: ko.storefront.used.conditions.new, condition: "NEW" },
];

// Kind filter buttons. `kind: null` is the "all" filter (no query filter). The
// other map to the static site's electric / diesel / lpg / reach-truck filters.
const FILTERS: ReadonlyArray<{ key: string; label: string; kind: ListingKind | null }> = [
  { key: "all", label: ko.storefront.used.filters.all, kind: null },
  { key: "electric", label: ko.storefront.used.filters.electric, kind: "ELECTRIC" },
  { key: "diesel", label: ko.storefront.used.filters.diesel, kind: "DIESEL" },
  { key: "lpg", label: ko.storefront.used.filters.lpg, kind: "LPG" },
  { key: "reach", label: ko.storefront.used.filters.reach, kind: "REACH" },
];

// Used/new equipment sales leads belong in the storefront inquiry inbox so the
// sales queue keeps the listing_id, topic, and lead lifecycle.
const INQUIRY_USED = "/contact?topic=USED_SALES";

// Single neutral fallback shown ONLY when a listing genuinely has no photo of
// its own. Real listing photos are served per-media from the object store via
// each media row's `url`.
const FALLBACK_IMAGE = "/sales/asset-06.jpg";

// capacity_milli is the load capacity in milli-tons (2.5 t = 2500). To a human
// tonnage value: capacity_milli / 1_000 → tonnes. Trim trailing ".0".
function formatCapacity(capacityMilli: number | null): string | null {
  if (capacityMilli == null) return null;
  const tonnes = capacityMilli / 1_000;
  const text = Number.isInteger(tonnes) ? String(tonnes) : tonnes.toFixed(1);
  return `${text}${ko.storefront.used.card.capacityUnit}`;
}

function formatPrice(priceWon: number | null): string {
  if (priceWon == null) return ko.storefront.used.card.priceOnRequest;
  return `₩${priceWon.toLocaleString("ko-KR")}`;
}

const SECONDARY_BTN =
  "inline-flex min-h-[48px] items-center justify-center gap-2 rounded border border-line bg-white px-5 font-bold text-ink transition-colors hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

const AMBER_BTN =
  "inline-flex min-h-[48px] items-center justify-center gap-2 rounded bg-signal px-5 font-black text-ink transition-transform hover:bg-signal-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink motion-safe:hover:-translate-y-0.5";

type LoadState = "loading" | "ready" | "error";

export default function UsedSalesPage() {
  const { api } = useAuth();
  const [activeCondition, setActiveCondition] = useState<string>("all");
  const [activeFilter, setActiveFilter] = useState<string>("all");
  const [listings, setListings] = useState<SalesListingView[]>([]);
  const [state, setState] = useState<LoadState>("loading");

  const load = useCallback(
    async (conditionKey: string, filterKey: string) => {
      const condition =
        CONDITIONS.find((c) => c.key === conditionKey) ?? CONDITIONS[0];
      const filter = FILTERS.find((f) => f.key === filterKey) ?? FILTERS[0];
      setState("loading");
      const { data } = await api
        .GET("/api/v1/storefront/listings", {
          params: {
            query: {
              limit: 24,
              ...(condition.condition ? { condition: condition.condition } : {}),
              ...(filter.kind ? { kind: filter.kind } : {}),
            },
          },
        })
        .catch(() => ({ data: undefined }) as const);
      if (!data) {
        setListings([]);
        setState("error");
        return;
      }
      setListings(data.items);
      setState("ready");
    },
    [api],
  );

  useEffect(() => {
    void Promise.resolve().then(() => load(activeCondition, activeFilter));
  }, [load, activeCondition, activeFilter]);

  // Keep the grid mounted on refetch — dim it rather than blanking to a spinner.
  const refetching = state === "loading" && listings.length > 0;

  return (
    <main className="flex-1">
      {/* Hero — decorative photo background with a left gradient scrim. */}
      <section
        aria-labelledby="used-hero-title"
        className="relative isolate overflow-hidden bg-ink text-white"
      >
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 bg-cover bg-center"
          style={{ backgroundImage: "url('/sales/asset-06.jpg')" }}
        />
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 bg-gradient-to-r from-ink via-ink/85 to-ink/30"
        />
        <div className="mx-auto w-full max-w-[1240px] px-5 py-20 sm:px-8 sm:py-24 lg:px-12 lg:py-28">
          <p className="text-[13px] font-black uppercase tracking-[0.14em] text-signal">
            {ko.storefront.used.hero.eyebrow}
          </p>
          <h1
            id="used-hero-title"
            className="balance-text mt-4 max-w-3xl text-[clamp(38px,6vw,72px)] font-extrabold leading-[1.08] tracking-[-0.02em]"
          >
            {ko.storefront.used.hero.title}
          </h1>
          <p className="mt-5 max-w-2xl text-[clamp(17px,2vw,22px)] leading-[1.7] text-white/85">
            {ko.storefront.used.hero.copy}
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a
              href="#inventory"
              className={cn(AMBER_BTN, "min-h-[52px] px-6")}
            >
              {ko.storefront.used.hero.primary}
              <ArrowRight aria-hidden="true" size={18} />
            </a>
            <Link
              to={INQUIRY_USED}
              className="inline-flex min-h-[52px] items-center justify-center gap-2 rounded border border-white/40 bg-white/10 px-6 font-black text-white transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              {ko.storefront.used.hero.secondary}
            </Link>
          </div>
        </div>
      </section>

      {/* Inventory — data-backed equipment grid */}
      <section
        id="inventory"
        aria-labelledby="used-inventory-title"
        className="bg-muted-panel"
      >
        <div className="mx-auto w-full max-w-[1240px] px-5 py-16 sm:px-8 lg:px-12 lg:py-20">
          <div className="max-w-2xl">
            <p className="text-[13px] font-black uppercase tracking-[0.14em] text-brand-teal">
              {ko.storefront.used.inventory.eyebrow}
            </p>
            <h2
              id="used-inventory-title"
              className="mt-3 text-[clamp(28px,3.4vw,44px)] font-extrabold leading-[1.12] text-ink"
            >
              {ko.storefront.used.inventory.title}
            </h2>
            <p className="mt-3 text-[18px] leading-[1.7] text-steel">
              {ko.storefront.used.inventory.copy}
            </p>
          </div>

          {/* Used/new sub-category tabs (the Sales category split). */}
          <div
            role="group"
            aria-label={ko.storefront.used.conditions.aria}
            className="mt-8 flex flex-wrap gap-2"
          >
            {CONDITIONS.map((condition) => {
              const isActive = condition.key === activeCondition;
              return (
                <button
                  key={condition.key}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => {
                    setActiveCondition(condition.key);
                  }}
                  className={cn(
                    "min-h-[44px] rounded-full border px-5 text-sm font-black transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-teal",
                    isActive
                      ? "border-brand-teal bg-brand-teal text-white"
                      : "border-line bg-white text-steel hover:border-brand-teal hover:text-brand-teal",
                  )}
                >
                  {condition.label}
                </button>
              );
            })}
          </div>

          {/* Kind filter buttons (plain button group with aria-pressed). */}
          <div
            role="group"
            aria-label={ko.storefront.used.filters.aria}
            className="mt-4 flex flex-wrap gap-2"
          >
            {FILTERS.map((filter) => {
              const isActive = filter.key === activeFilter;
              return (
                <button
                  key={filter.key}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => {
                    setActiveFilter(filter.key);
                  }}
                  className={cn(
                    "min-h-[44px] rounded border px-4 text-sm font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
                    isActive
                      ? "border-ink bg-ink text-white"
                      : "border-line bg-white text-steel hover:border-ink hover:text-ink",
                  )}
                >
                  {filter.label}
                </button>
              );
            })}
          </div>

          {/* Live region announcing the current result count / state. */}
          <p className="sr-only" role="status" aria-live="polite">
            {state === "loading"
              ? ko.storefront.used.inventory.loading
              : state === "error"
                ? ko.storefront.used.inventory.error
                : String(listings.length)}
          </p>

          {/* Initial load (no listings yet) */}
          {state === "loading" && listings.length === 0 ? (
            <div className="mt-12 flex items-center justify-center gap-3 py-16 text-steel">
              <Loader2
                aria-hidden="true"
                size={22}
                className="motion-safe:animate-spin"
              />
              <span className="text-sm font-semibold">
                {ko.storefront.used.inventory.loading}
              </span>
            </div>
          ) : null}

          {state === "error" ? (
            <div className="mt-12 flex flex-col items-center gap-4 rounded-xl border border-line bg-white py-14 text-center">
              <p className="max-w-md text-[15px] text-steel">
                {ko.storefront.used.inventory.error}
              </p>
              <button
                type="button"
                onClick={() => void load(activeCondition, activeFilter)}
                className={SECONDARY_BTN}
              >
                <RotateCw aria-hidden="true" size={16} />
                {ko.storefront.used.inventory.retry}
              </button>
            </div>
          ) : null}

          {state === "ready" && listings.length === 0 ? (
            <div className="mt-12 flex flex-col items-center gap-3 rounded-xl border border-line bg-white py-16 text-center">
              <h3 className="text-lg font-extrabold text-ink">
                {activeCondition === "used"
                  ? ko.storefront.used.empty.usedTitle
                  : activeCondition === "new"
                    ? ko.storefront.used.empty.newTitle
                    : ko.storefront.used.empty.title}
              </h3>
              <p className="max-w-md text-[15px] leading-[1.7] text-steel">
                {ko.storefront.used.empty.copy}
              </p>
              <Link to={INQUIRY_USED} className={cn(AMBER_BTN, "mt-2")}>
                {ko.storefront.used.empty.cta}
                <ArrowRight aria-hidden="true" size={16} />
              </Link>
            </div>
          ) : null}

          {listings.length > 0 ? (
            <div
              className={cn(
                "mt-10 grid gap-6 transition-opacity sm:grid-cols-2 lg:grid-cols-3",
                refetching && "opacity-50",
              )}
              aria-busy={refetching}
            >
              {listings.map((listing) => (
                <EquipmentCard key={listing.id} listing={listing} />
              ))}
            </div>
          ) : null}
        </div>
      </section>

      {/* Buying guide — split panel with check-list */}
      <section
        aria-labelledby="used-guide-title"
        className="bg-white"
      >
        <div className="mx-auto grid w-full max-w-[1240px] gap-10 px-5 py-16 sm:px-8 lg:grid-cols-[1fr_1.1fr] lg:gap-16 lg:px-12 lg:py-20">
          <div>
            <p className="text-[13px] font-black uppercase tracking-[0.14em] text-brand-teal">
              {ko.storefront.used.buyingGuide.eyebrow}
            </p>
            <h2
              id="used-guide-title"
              className="mt-3 text-[clamp(28px,3.4vw,44px)] font-extrabold leading-[1.12] text-ink"
            >
              {ko.storefront.used.buyingGuide.title}
            </h2>
          </div>
          <ul className="grid gap-3">
            {ko.storefront.used.buyingGuide.items.map((item) => (
              <li
                key={item}
                className="flex items-start gap-3 rounded-xl border border-line bg-white px-5 py-4 text-[17px] text-ink"
              >
                <span className="mt-0.5 inline-flex h-6 w-6 flex-none items-center justify-center rounded-full bg-brand-teal text-white">
                  <Check aria-hidden="true" size={15} />
                </span>
                <span className="leading-[1.7]">{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Contact band — online intake first, phone last resort. */}
      <section
        aria-labelledby="used-contact-title"
        className="bg-ink text-white"
      >
        <div className="mx-auto grid w-full max-w-[1240px] items-center gap-6 px-5 py-14 sm:px-8 lg:grid-cols-[1.4fr_auto_auto] lg:gap-10 lg:px-12">
          <div>
            <p className="text-[13px] font-black uppercase tracking-[0.14em] text-signal">
              {ko.storefront.used.contactBand.eyebrow}
            </p>
            <h2
              id="used-contact-title"
              className="mt-3 text-[clamp(28px,3.4vw,44px)] font-extrabold leading-[1.12]"
            >
              {ko.storefront.used.contactBand.title}
            </h2>
          </div>
          <div className="flex flex-col">
            <span className="text-[12px] font-black uppercase tracking-[0.14em] text-white/60">
              {ko.storefront.used.contactBand.numberLabel}
            </span>
            <a
              href={ko.storefront.nav.phoneHref}
              className="mt-1 text-xl font-extrabold text-signal underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
            >
              {ko.storefront.used.contactBand.number}
            </a>
          </div>
          <Link
            to={INQUIRY_USED}
            className="inline-flex min-h-[52px] items-center justify-center gap-2.5 rounded bg-signal px-6 font-black text-ink transition-transform hover:bg-signal-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white motion-safe:hover:-translate-y-0.5"
          >
            {ko.storefront.used.contactBand.cta}
            <ArrowRight aria-hidden="true" size={18} />
          </Link>
        </div>
      </section>
    </main>
  );
}

/** A single inventory card: image, badge, model, spec rows, and an inquiry CTA. */
function EquipmentCard({ listing }: { listing: SalesListingView }) {
  const cardCopy = ko.storefront.used.card;
  // Render the listing's OWN first photo when it has one; a single neutral
  // fallback otherwise (never a fabricated stock-photo grid). `media` may be
  // empty, so guard the first element rather than index it unconditionally.
  const primaryMedia = listing.media.length > 0 ? listing.media[0] : null;
  const imageSrc = primaryMedia ? primaryMedia.url : FALLBACK_IMAGE;
  const imageAlt = primaryMedia ? primaryMedia.alt_text ?? listing.model_name : listing.model_name;
  const capacity = formatCapacity(listing.capacity_milli);

  // Spec rows surfaced only when the backend provides them.
  type SpecRow = { label: string; value: string };
  const specRows: (SpecRow | null)[] = [
    listing.usage_label
      ? { label: cardCopy.usage, value: listing.usage_label }
      : null,
    listing.condition_label
      ? { label: cardCopy.condition, value: listing.condition_label }
      : null,
    listing.availability
      ? { label: cardCopy.availability, value: listing.availability }
      : null,
    listing.model_year
      ? {
          label: cardCopy.year,
          value: `${String(listing.model_year)}${cardCopy.yearUnit}`,
        }
      : null,
    listing.usage_hours != null
      ? {
          label: cardCopy.hours,
          value: `${listing.usage_hours.toLocaleString("ko-KR")}${cardCopy.hoursUnit}`,
        }
      : null,
  ];
  const specs: SpecRow[] = specRows.filter(
    (row): row is SpecRow => row !== null,
  );

  return (
    <article className="flex flex-col overflow-hidden rounded-xl border border-line bg-white">
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-muted-panel">
        <img
          src={imageSrc}
          alt={imageAlt}
          loading="lazy"
          className="h-full w-full object-cover"
        />
        {capacity ? (
          <span className="absolute left-3 top-3 inline-flex items-center rounded bg-ink/85 px-2.5 py-1 text-xs font-bold text-white">
            {capacity}
          </span>
        ) : null}
      </div>

      <div className="flex flex-1 flex-col gap-4 p-5">
        {listing.badge ? (
          <span className="inline-flex min-h-8 w-fit items-center rounded border border-brand-teal/30 bg-brand-teal/10 px-2.5 py-1 text-xs font-bold text-brand-teal">
            {listing.badge}
          </span>
        ) : null}

        <h3 className="text-lg font-extrabold text-ink">{listing.model_name}</h3>

        {specs.length > 0 ? (
          <dl className="grid gap-2 text-sm">
            {specs.map((row) => (
              <div key={row.label} className="flex justify-between gap-4">
                <dt className="text-steel">{row.label}</dt>
                <dd className="text-right font-semibold text-ink">{row.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        <div className="mt-auto flex items-center justify-between gap-3 border-t border-line pt-4">
          <span className="text-lg font-extrabold text-ink">
            {formatPrice(listing.price_won)}
          </span>
          <Link
            to={`/contact?listing=${listing.id}&topic=USED_SALES`}
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded bg-ink px-4 text-sm font-black text-white transition-colors hover:bg-ink/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            {cardCopy.cta}
            <ArrowRight aria-hidden="true" size={16} />
          </Link>
        </div>
      </div>
    </article>
  );
}
