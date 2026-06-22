import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Check, Loader2, RotateCw } from "lucide-react";
import { Link } from "react-router-dom";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";
import { cn } from "../lib/utils";
import type { ListingKind, SalesListingView } from "../api/types";

/**
 * Used-sales catalog page (#6 KNL). Routed child of PublicLayout — returns only
 * its <main>. Data-backed: on mount (and on filter change) it pulls the public
 * storefront listings and renders each as an equipment card with an inquiry CTA
 * that deep-links into the contact form (?listing={id}&topic=USED_SALES). All
 * copy comes from ko.storefront.used.*.
 */

// Kind filter tabs. `kind: null` is the "all" tab (no query filter). The other
// three map to the static site's electric / diesel / reach-truck filters.
const FILTERS: ReadonlyArray<{ key: string; label: string; kind: ListingKind | null }> = [
  { key: "all", label: ko.storefront.used.filters.all, kind: null },
  { key: "electric", label: ko.storefront.used.filters.electric, kind: "ELECTRIC" },
  { key: "diesel", label: ko.storefront.used.filters.diesel, kind: "DIESEL" },
  { key: "lpg", label: ko.storefront.used.filters.lpg, kind: "LPG" },
  { key: "reach", label: ko.storefront.used.filters.reach, kind: "REACH" },
];

// The static site fell back to asset-17..20 photography for every card. We have
// no media-serving endpoint (ListingMediaView carries no URL — only id /
// content_type / alt_text / sort_order), so cards always render a deterministic
// placeholder keyed by listing index to vary the grid.
const PLACEHOLDER_IMAGES = [
  "/sales/asset-17.jpg",
  "/sales/asset-18.jpg",
  "/sales/asset-19.jpg",
  "/sales/asset-20.jpg",
] as const;

function placeholderFor(index: number): string {
  return PLACEHOLDER_IMAGES[index % PLACEHOLDER_IMAGES.length];
}

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

type LoadState = "loading" | "ready" | "error";

export default function UsedSalesPage() {
  const { api } = useAuth();
  const [activeFilter, setActiveFilter] = useState<string>("all");
  const [listings, setListings] = useState<SalesListingView[]>([]);
  const [state, setState] = useState<LoadState>("loading");

  const load = useCallback(
    async (filterKey: string) => {
      const filter = FILTERS.find((f) => f.key === filterKey) ?? FILTERS[0];
      setState("loading");
      const { data } = await api
        .GET("/api/v1/storefront/listings", {
          params: {
            query: {
              limit: 24,
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
    void Promise.resolve().then(() => load(activeFilter));
  }, [load, activeFilter]);

  return (
    <main className="flex-1">
      {/* Hero — dark photo with left gradient scrim */}
      <section className="relative isolate overflow-hidden bg-ink text-white">
        <img
          src="/sales/asset-06.jpg"
          alt={ko.storefront.used.hero.imageAlt}
          className="absolute inset-0 -z-10 h-full w-full object-cover"
        />
        <div className="absolute inset-0 -z-10 bg-gradient-to-r from-ink via-ink/85 to-ink/30" />
        <div className="mx-auto w-full max-w-[1240px] px-5 py-20 sm:px-8 sm:py-24 lg:px-12 lg:py-28">
          <p className="text-sm font-bold uppercase tracking-[0.18em] text-signal">
            {ko.storefront.used.hero.eyebrow}
          </p>
          <h1 className="mt-4 max-w-3xl text-3xl font-extrabold leading-tight sm:text-4xl lg:text-5xl">
            {ko.storefront.used.hero.title}
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-relaxed text-white/85 sm:text-lg">
            {ko.storefront.used.hero.copy}
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button
              asChild
              className="bg-signal text-ink hover:bg-signal-dark focus-visible:outline-signal"
            >
              <a href="#inventory">
                {ko.storefront.used.hero.primary}
                <ArrowRight aria-hidden="true" size={18} />
              </a>
            </Button>
            <Button
              asChild
              variant="secondary"
              className="border-white/40 bg-transparent text-white hover:bg-white/10 focus-visible:outline-white"
            >
              <Link to="/contact?topic=USED_SALES">
                {ko.storefront.used.hero.secondary}
              </Link>
            </Button>
          </div>
        </div>
      </section>

      {/* Inventory — data-backed equipment grid */}
      <section id="inventory" className="bg-[#f6f8fa]">
        <div className="mx-auto w-full max-w-[1240px] px-5 py-16 sm:px-8 lg:px-12 lg:py-20">
          <div className="max-w-2xl">
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-brand-teal">
              {ko.storefront.used.inventory.eyebrow}
            </p>
            <h2 className="mt-3 text-2xl font-extrabold text-ink sm:text-3xl">
              {ko.storefront.used.inventory.title}
            </h2>
            <p className="mt-3 text-base leading-relaxed text-steel">
              {ko.storefront.used.inventory.copy}
            </p>
          </div>

          {/* Kind filter tabs */}
          <div
            role="tablist"
            aria-label={ko.storefront.used.filters.aria}
            className="mt-8 flex flex-wrap gap-2"
          >
            {FILTERS.map((filter) => {
              const isActive = filter.key === activeFilter;
              return (
                <button
                  key={filter.key}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => {
                    setActiveFilter(filter.key);
                  }}
                  className={cn(
                    "min-h-10 rounded border px-4 text-sm font-bold transition-colors",
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

          {/* States */}
          {state === "loading" ? (
            <div className="mt-12 flex items-center justify-center gap-3 py-16 text-steel">
              <Loader2 aria-hidden="true" size={22} className="animate-spin" />
              <span className="text-sm font-semibold">
                {ko.storefront.used.inventory.loading}
              </span>
            </div>
          ) : null}

          {state === "error" ? (
            <Card className="mt-12 flex flex-col items-center gap-4 border-line py-14 text-center">
              <p className="max-w-md text-sm text-steel">
                {ko.storefront.used.inventory.error}
              </p>
              <Button variant="secondary" onClick={() => void load(activeFilter)}>
                <RotateCw aria-hidden="true" size={16} />
                {ko.storefront.used.inventory.retry}
              </Button>
            </Card>
          ) : null}

          {state === "ready" && listings.length === 0 ? (
            <Card className="mt-12 flex flex-col items-center gap-3 border-line py-16 text-center">
              <h3 className="text-lg font-extrabold text-ink">
                {ko.storefront.used.empty.title}
              </h3>
              <p className="max-w-md text-sm leading-relaxed text-steel">
                {ko.storefront.used.empty.copy}
              </p>
              <Button
                asChild
                className="mt-2 bg-signal text-ink hover:bg-signal-dark focus-visible:outline-signal"
              >
                <Link to="/contact?topic=USED_SALES">
                  {ko.storefront.used.empty.cta}
                </Link>
              </Button>
            </Card>
          ) : null}

          {state === "ready" && listings.length > 0 ? (
            <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {listings.map((listing, index) => (
                <EquipmentCard key={listing.id} listing={listing} index={index} />
              ))}
            </div>
          ) : null}
        </div>
      </section>

      {/* Buying guide — split panel with check-list */}
      <section className="bg-muted-panel">
        <div className="mx-auto grid w-full max-w-[1240px] gap-10 px-5 py-16 sm:px-8 lg:grid-cols-[1fr_1.1fr] lg:gap-16 lg:px-12 lg:py-20">
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-brand-teal">
              {ko.storefront.used.buyingGuide.eyebrow}
            </p>
            <h2 className="mt-3 text-2xl font-extrabold leading-snug text-ink sm:text-3xl">
              {ko.storefront.used.buyingGuide.title}
            </h2>
          </div>
          <ul className="grid gap-3">
            {ko.storefront.used.buyingGuide.items.map((item) => (
              <li
                key={item}
                className="flex items-start gap-3 rounded-lg border border-line bg-white px-5 py-4 text-base text-ink"
              >
                <span className="mt-0.5 inline-flex h-6 w-6 flex-none items-center justify-center rounded-full bg-brand-teal text-white">
                  <Check aria-hidden="true" size={15} />
                </span>
                <span className="leading-relaxed">{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Contact band */}
      <section className="bg-ink text-white">
        <div className="mx-auto grid w-full max-w-[1240px] items-center gap-6 px-5 py-14 sm:px-8 lg:grid-cols-[1.4fr_auto_auto] lg:gap-10 lg:px-12">
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-signal">
              {ko.storefront.used.contactBand.eyebrow}
            </p>
            <h2 className="mt-3 text-2xl font-extrabold leading-snug sm:text-3xl">
              {ko.storefront.used.contactBand.title}
            </h2>
          </div>
          <div className="flex flex-col">
            <span className="text-xs font-bold uppercase tracking-[0.14em] text-white/60">
              {ko.storefront.used.contactBand.numberLabel}
            </span>
            <a
              href={ko.storefront.nav.phoneHref}
              className="mt-1 text-2xl font-extrabold text-signal"
            >
              {ko.storefront.used.contactBand.number}
            </a>
          </div>
          <Button
            asChild
            className="bg-signal text-ink hover:bg-signal-dark focus-visible:outline-signal"
          >
            <Link to="/contact?topic=USED_SALES">
              {ko.storefront.used.contactBand.cta}
            </Link>
          </Button>
        </div>
      </section>
    </main>
  );
}

/** A single inventory card: image, badge, model, spec rows, and an inquiry CTA. */
function EquipmentCard({
  listing,
  index,
}: {
  listing: SalesListingView;
  index: number;
}) {
  const cardCopy = ko.storefront.used.card;
  const imageAlt = listing.media[0]?.alt_text ?? listing.model_name;
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
      ? { label: cardCopy.inquiry, value: listing.availability }
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
    <Card className="flex flex-col overflow-hidden p-0">
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-muted-panel">
        <img
          src={placeholderFor(index)}
          alt={imageAlt}
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
          <Badge className="self-start border-brand-teal/30 bg-brand-teal/10 text-brand-teal">
            {listing.badge}
          </Badge>
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
          <Button asChild size="sm">
            <Link to={`/contact?listing=${listing.id}&topic=USED_SALES`}>
              {cardCopy.cta}
              <ArrowRight aria-hidden="true" size={16} />
            </Link>
          </Button>
        </div>
      </div>
    </Card>
  );
}
