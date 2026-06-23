import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Pencil, Plus, Trash2, X } from "lucide-react";

import type {
  CreateListingRequest,
  CustomerInquiryView,
  InquiryStatus,
  ListingCondition,
  ListingKind,
  ListingStatus,
  ListingType,
  SalesListingView,
  UpdateListingRequest,
} from "../api/types";
import { useAuth } from "../context/auth";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { PageError } from "../components/states/PageError";
import { PageSpinner } from "../components/states/PageSpinner";
import { PageEmpty } from "../components/states/PageEmpty";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import {
  AsyncCombobox,
  type ComboboxOption,
} from "../components/ui/combobox";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { cn, safeLabel } from "../lib/utils";
import { ko } from "../i18n/ko";

type Tab = "listings" | "inquiries";
type ReadState = "idle" | "loading" | "error";

const KIND_OPTIONS: ListingKind[] = ["ELECTRIC", "DIESEL", "LPG", "REACH"];
const CONDITION_OPTIONS: ListingCondition[] = ["USED", "NEW"];
const LISTING_TYPE_OPTIONS: ListingType[] = ["SALE", "RENTAL", "BOTH"];
const STATUS_OPTIONS: ListingStatus[] = [
  "DRAFT",
  "PUBLISHED",
  "RESERVED",
  "SOLD",
  "WITHDRAWN",
];
const INQUIRY_STATUS_OPTIONS: InquiryStatus[] = ["NEW", "CONTACTED", "CLOSED"];

const INQUIRY_BADGE: Record<InquiryStatus, string> = {
  NEW: "border-brand-teal bg-brand-teal/10 text-brand-teal",
  CONTACTED: "border-signal-dark bg-signal/15 text-signal-dark",
  CLOSED: "border-line text-steel",
};

/** Editable string mirror of CreateListingRequest. Numbers are kept as raw
 * input strings so an empty box round-trips to `null` rather than `0`. */
interface ListingForm {
  kind: ListingKind;
  condition: ListingCondition;
  model_name: string;
  capacity_milli: string;
  model_year: string;
  usage_hours: string;
  price_won: string;
  badge: string;
  usage_label: string;
  condition_label: string;
  availability: string;
  location: string;
  description: string;
  listing_type: ListingType;
  status: ListingStatus;
  sort_weight: string;
  equipment_id: string;
}

const EMPTY_FORM: ListingForm = {
  kind: "ELECTRIC",
  condition: "USED",
  model_name: "",
  capacity_milli: "",
  model_year: "",
  usage_hours: "",
  price_won: "",
  badge: "",
  usage_label: "",
  condition_label: "",
  availability: "",
  location: "",
  description: "",
  listing_type: "SALE",
  status: "DRAFT",
  sort_weight: "0",
  equipment_id: "",
};

function toForm(listing: SalesListingView): ListingForm {
  const str = (value: number | null) => (value === null ? "" : String(value));
  return {
    kind: listing.kind,
    condition: listing.condition,
    model_name: listing.model_name,
    capacity_milli: str(listing.capacity_milli),
    model_year: str(listing.model_year),
    usage_hours: str(listing.usage_hours),
    price_won: str(listing.price_won),
    badge: listing.badge ?? "",
    usage_label: listing.usage_label ?? "",
    condition_label: listing.condition_label ?? "",
    availability: listing.availability ?? "",
    location: listing.location ?? "",
    description: listing.description ?? "",
    listing_type: listing.listing_type,
    status: listing.status,
    sort_weight: String(listing.sort_weight),
    equipment_id: listing.equipment_id ?? "",
  };
}

/** Trim → `null` for an optional nullable text column. */
function nullableText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Parse an integer box → `null` when blank/invalid (never silently 0). */
function nullableInt(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function toCreateRequest(form: ListingForm): CreateListingRequest {
  return {
    kind: form.kind,
    condition: form.condition,
    model_name: form.model_name.trim(),
    capacity_milli: nullableInt(form.capacity_milli),
    model_year: nullableInt(form.model_year),
    usage_hours: nullableInt(form.usage_hours),
    price_won: nullableInt(form.price_won),
    badge: nullableText(form.badge),
    usage_label: nullableText(form.usage_label),
    condition_label: nullableText(form.condition_label),
    availability: nullableText(form.availability),
    location: nullableText(form.location),
    description: nullableText(form.description),
    listing_type: form.listing_type,
    status: form.status,
    sort_weight: nullableInt(form.sort_weight) ?? 0,
    equipment_id: nullableText(form.equipment_id),
  };
}

/**
 * Build a PATCH body that contains ONLY the fields the user actually changed.
 *
 * openapi-fetch drops `undefined` keys, so an unchanged field is omitted (left
 * unchanged server-side). A field the user cleared is sent as explicit `null`
 * to clear the stored column; a field set to a new value is sent as that value.
 * This avoids wiping unedited columns back to null on every save.
 */
function toUpdateRequest(
  original: SalesListingView,
  form: ListingForm,
): UpdateListingRequest {
  const next = toCreateRequest(form);
  const body: UpdateListingRequest = {};

  // Required (non-nullable) string: only send when it changed.
  if (next.model_name !== original.model_name) body.model_name = next.model_name;

  // Non-nullable enums / number.
  if (next.kind !== original.kind) body.kind = next.kind;
  if (next.condition !== original.condition) body.condition = next.condition;
  if (next.listing_type !== original.listing_type)
    body.listing_type = next.listing_type;
  if (next.status !== original.status) body.status = next.status;
  if (next.sort_weight !== original.sort_weight)
    body.sort_weight = next.sort_weight;

  // Nullable fields: send the new value (including explicit null to clear) only
  // when it differs from what is stored.
  if (next.capacity_milli !== original.capacity_milli)
    body.capacity_milli = next.capacity_milli;
  if (next.model_year !== original.model_year)
    body.model_year = next.model_year;
  if (next.usage_hours !== original.usage_hours)
    body.usage_hours = next.usage_hours;
  if (next.price_won !== original.price_won) body.price_won = next.price_won;
  if (next.badge !== original.badge) body.badge = next.badge;
  if (next.usage_label !== original.usage_label)
    body.usage_label = next.usage_label;
  if (next.condition_label !== original.condition_label)
    body.condition_label = next.condition_label;
  if (next.availability !== original.availability)
    body.availability = next.availability;
  if (next.location !== original.location) body.location = next.location;
  if (next.description !== original.description)
    body.description = next.description;
  if (next.equipment_id !== original.equipment_id)
    body.equipment_id = next.equipment_id;

  return body;
}

function formatPrice(price: number | null): string {
  if (price === null) return ko.storefront.used.card.priceOnRequest;
  return `₩${price.toLocaleString("ko-KR")}`;
}

function formatCapacity(capacityMilli: number | null): string {
  if (capacityMilli === null) return "—";
  // capacity_milli is milli-tons (2.5 t = 2500); render as tons with up to one
  // decimal.
  const tons = capacityMilli / 1_000;
  return `${String(Number.isInteger(tons) ? tons : tons.toFixed(1))}T`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export function CatalogAdminPage() {
  const { api } = useAuth();
  const [tab, setTab] = useState<Tab>("listings");

  // ----- Listings -----
  const [listings, setListings] = useState<SalesListingView[]>([]);
  const [listingsState, setListingsState] = useState<ReadState>("loading");
  const [editing, setEditing] = useState<SalesListingView | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<ListingForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);

  // ----- Inquiries -----
  const [inquiries, setInquiries] = useState<CustomerInquiryView[]>([]);
  const [inquiriesState, setInquiriesState] = useState<ReadState>("loading");
  const [inquiryFilter, setInquiryFilter] = useState<InquiryStatus | "ALL">("ALL");
  const [inquiryError, setInquiryError] = useState(false);
  const [inquiryBusyId, setInquiryBusyId] = useState<string | null>(null);

  const loadListings = useCallback(async () => {
    setListingsState("loading");
    const { data } = await api
      .GET("/api/v1/sales/listings", {
        params: { query: { limit: 100, offset: 0 } },
      })
      .catch(() => ({ data: undefined, error: true }) as const);
    if (!data) {
      setListingsState("error");
      return;
    }
    setListings(data.items);
    setListingsState("idle");
  }, [api]);

  const loadInquiries = useCallback(async () => {
    setInquiriesState("loading");
    const { data } = await api
      .GET("/api/v1/sales/inquiries", {
        params: {
          query: {
            status: inquiryFilter === "ALL" ? undefined : inquiryFilter,
            limit: 100,
            offset: 0,
          },
        },
      })
      .catch(() => ({ data: undefined, error: true }) as const);
    if (!data) {
      setInquiriesState("error");
      return;
    }
    setInquiries(data.items);
    setInquiriesState("idle");
  }, [api, inquiryFilter]);

  useEffect(() => {
    void Promise.resolve().then(loadListings);
  }, [loadListings]);

  useEffect(() => {
    void Promise.resolve().then(loadInquiries);
  }, [loadInquiries]);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setSaveError(false);
    setShowForm(true);
  }

  function openEdit(listing: SalesListingView) {
    setEditing(listing);
    setForm(toForm(listing));
    setSaveError(false);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditing(null);
    setSaveError(false);
  }

  async function submitForm() {
    if (form.model_name.trim().length === 0) {
      setSaveError(true);
      return;
    }
    setSaving(true);
    setSaveError(false);
    try {
      if (editing) {
        const body = toUpdateRequest(editing, form);
        const { error } = await api.PATCH("/api/v1/sales/listings/{id}", {
          params: { path: { id: editing.id } },
          body,
        });
        if (error) throw new Error("update listing failed");
      } else {
        const { data } = await api.POST("/api/v1/sales/listings", {
          body: toCreateRequest(form),
        });
        if (!data) throw new Error("create listing failed");
      }
      closeForm();
      await loadListings();
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  }

  async function deleteListing(id: string) {
    setDeletingId(id);
    try {
      const { error } = await api.DELETE("/api/v1/sales/listings/{id}", {
        params: { path: { id } },
      });
      if (error) throw new Error("delete listing failed");
      await loadListings();
    } catch {
      setListingsState("error");
    } finally {
      setDeletingId(null);
    }
  }

  async function setListingStatus(listing: SalesListingView, status: ListingStatus) {
    setRowBusyId(listing.id);
    try {
      const { error } = await api.PATCH("/api/v1/sales/listings/{id}", {
        params: { path: { id: listing.id } },
        body: { status },
      });
      if (error) throw new Error("status change failed");
      await loadListings();
    } catch {
      setListingsState("error");
    } finally {
      setRowBusyId(null);
    }
  }

  async function setInquiryStatus(inquiry: CustomerInquiryView, status: InquiryStatus) {
    setInquiryBusyId(inquiry.id);
    setInquiryError(false);
    try {
      const { error } = await api.PATCH("/api/v1/sales/inquiries/{id}", {
        params: { path: { id: inquiry.id } },
        body: { status },
      });
      if (error) throw new Error("inquiry status change failed");
      await loadInquiries();
    } catch {
      setInquiryError(true);
    } finally {
      setInquiryBusyId(null);
    }
  }

  const newCount = useMemo(
    () => inquiries.filter((inquiry) => inquiry.status === "NEW").length,
    [inquiries],
  );

  return (
    <>
      <PageHeader
        title={ko.catalog.title}
        description={ko.catalog.subtitle}
        actions={
          <RefreshButton
            onClick={() => {
              void (tab === "listings" ? loadListings() : loadInquiries());
            }}
            isLoading={
              (tab === "listings" ? listingsState : inquiriesState) === "loading"
            }
          />
        }
      />

      <div
        role="tablist"
        aria-label={ko.catalog.title}
        className="mb-6 flex gap-1 border-b border-line"
      >
        <TabButton
          active={tab === "listings"}
          onClick={() => {
            setTab("listings");
          }}
          label={ko.catalog.tabs.listings}
        />
        <TabButton
          active={tab === "inquiries"}
          onClick={() => {
            setTab("inquiries");
          }}
          label={ko.catalog.tabs.inquiries}
          count={newCount}
        />
      </div>

      {tab === "listings" ? (
        <ListingsTab
          listings={listings}
          state={listingsState}
          deletingId={deletingId}
          rowBusyId={rowBusyId}
          onRetry={() => void loadListings()}
          onCreate={openCreate}
          onEdit={openEdit}
          onDelete={(id) => {
            void deleteListing(id);
          }}
          onSetStatus={(listing, status) => {
            void setListingStatus(listing, status);
          }}
        />
      ) : (
        <InquiriesTab
          inquiries={inquiries}
          state={inquiriesState}
          filter={inquiryFilter}
          showError={inquiryError}
          busyId={inquiryBusyId}
          onFilter={setInquiryFilter}
          onRetry={() => void loadInquiries()}
          onSetStatus={(inquiry, status) => {
            void setInquiryStatus(inquiry, status);
          }}
        />
      )}

      {showForm ? (
        <ListingFormDialog
          form={form}
          editing={editing !== null}
          saving={saving}
          saveError={saveError}
          onChange={setForm}
          onCancel={closeForm}
          onSubmit={() => void submitForm()}
        />
      ) : null}
    </>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "-mb-px flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-semibold transition-colors",
        active
          ? "border-ink text-ink"
          : "border-transparent text-steel hover:text-ink",
      )}
    >
      {label}
      {count && count > 0 ? (
        <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-signal px-1.5 text-xs font-bold text-ink">
          {count}
        </span>
      ) : null}
    </button>
  );
}

function ListingsTab({
  listings,
  state,
  deletingId,
  rowBusyId,
  onRetry,
  onCreate,
  onEdit,
  onDelete,
  onSetStatus,
}: {
  listings: SalesListingView[];
  state: ReadState;
  deletingId: string | null;
  rowBusyId: string | null;
  onRetry: () => void;
  onCreate: () => void;
  onEdit: (listing: SalesListingView) => void;
  onDelete: (id: string) => void;
  onSetStatus: (listing: SalesListingView, status: ListingStatus) => void;
}) {
  return (
    <Card className="p-0">
      <header className="flex items-center justify-between gap-4 border-b border-line px-4 py-3">
        <h2 className="text-base font-semibold text-ink">
          {ko.catalog.listings.heading}
        </h2>
        <Button type="button" size="sm" onClick={onCreate}>
          <Plus size={16} aria-hidden="true" />
          {ko.catalog.listings.newButton}
        </Button>
      </header>

      {state === "loading" ? <PageSpinner /> : null}
      {state === "error" ? (
        <div className="p-4">
          <PageError message={ko.catalog.listings.error} onRetry={onRetry} />
        </div>
      ) : null}
      {state === "idle" && listings.length === 0 ? (
        <div className="p-4">
          <PageEmpty message={ko.catalog.listings.empty} />
        </div>
      ) : null}

      {state === "idle" && listings.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-left text-sm">
            <thead className="border-b border-line bg-muted-panel text-xs uppercase tracking-wide text-steel">
              <tr>
                <th className="px-4 py-3 font-semibold">
                  {ko.catalog.listings.columns.model}
                </th>
                <th className="px-4 py-3 font-semibold">
                  {ko.catalog.listings.columns.kind}
                </th>
                <th className="px-4 py-3 font-semibold">
                  {ko.catalog.listings.columns.condition}
                </th>
                <th className="px-4 py-3 font-semibold">
                  {ko.catalog.listings.columns.listingType}
                </th>
                <th className="px-4 py-3 font-semibold">
                  {ko.catalog.listings.columns.capacity}
                </th>
                <th className="px-4 py-3 font-semibold">
                  {ko.catalog.listings.columns.year}
                </th>
                <th className="px-4 py-3 font-semibold">
                  {ko.catalog.listings.columns.hours}
                </th>
                <th className="px-4 py-3 font-semibold">
                  {ko.catalog.listings.columns.price}
                </th>
                <th className="px-4 py-3 font-semibold">
                  {ko.catalog.listings.columns.status}
                </th>
                <th className="px-4 py-3 font-semibold">
                  {ko.catalog.listings.columns.updatedAt}
                </th>
                <th className="px-4 py-3 text-right font-semibold">
                  {ko.catalog.listings.columns.actions}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {listings.map((listing) => {
                const busy = rowBusyId === listing.id;
                return (
                  <tr key={listing.id} className="align-middle hover:bg-muted-panel/50">
                    <td className="px-4 py-3 font-medium text-ink">
                      {listing.model_name}
                      {listing.badge ? (
                        <span className="ml-2 align-middle text-xs font-semibold text-signal-dark">
                          {listing.badge}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-steel">
                      {ko.catalog.kindLabels[listing.kind]}
                    </td>
                    <td className="px-4 py-3 text-steel">
                      {ko.catalog.conditionLabels[listing.condition]}
                    </td>
                    <td className="px-4 py-3 text-steel">
                      {ko.catalog.listingTypeLabels[listing.listing_type]}
                    </td>
                    <td className="px-4 py-3 text-steel">
                      {formatCapacity(listing.capacity_milli)}
                    </td>
                    <td className="px-4 py-3 text-steel">
                      {listing.model_year ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-steel">
                      {listing.usage_hours !== null
                        ? listing.usage_hours.toLocaleString("ko-KR")
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-steel">
                      {formatPrice(listing.price_won)}
                    </td>
                    <td className="px-4 py-3">
                      <Select
                        aria-label={ko.catalog.form.statusLabel}
                        className="min-h-9 w-32 px-2 py-1 text-sm"
                        value={listing.status}
                        disabled={busy}
                        onChange={(event) => {
                          onSetStatus(listing, event.target.value as ListingStatus);
                        }}
                      >
                        {STATUS_OPTIONS.map((status) => (
                          <option key={status} value={status}>
                            {ko.catalog.statusLabels[status]}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="px-4 py-3 text-steel">
                      {formatDate(listing.updated_at)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            onEdit(listing);
                          }}
                        >
                          <Pencil size={14} aria-hidden="true" />
                          {ko.catalog.listings.actions.edit}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-red-700 hover:bg-red-50"
                          disabled={deletingId === listing.id}
                          onClick={() => {
                            if (
                              window.confirm(
                                ko.catalog.listings.actions.deleteConfirm,
                              )
                            ) {
                              onDelete(listing.id);
                            }
                          }}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                          {ko.catalog.listings.actions.delete}
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

function InquiriesTab({
  inquiries,
  state,
  filter,
  showError,
  busyId,
  onFilter,
  onRetry,
  onSetStatus,
}: {
  inquiries: CustomerInquiryView[];
  state: ReadState;
  filter: InquiryStatus | "ALL";
  showError: boolean;
  busyId: string | null;
  onFilter: (filter: InquiryStatus | "ALL") => void;
  onRetry: () => void;
  onSetStatus: (inquiry: CustomerInquiryView, status: InquiryStatus) => void;
}) {
  return (
    <Card className="p-0">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-line px-4 py-3">
        <h2 className="text-base font-semibold text-ink">
          {ko.catalog.inquiries.heading}
        </h2>
        <Select
          aria-label={ko.catalog.inquiries.columns.status}
          className="min-h-9 w-40 px-2 py-1 text-sm"
          value={filter}
          onChange={(event) => {
            onFilter(event.target.value as InquiryStatus | "ALL");
          }}
        >
          <option value="ALL">{ko.catalog.inquiries.statusFilter.all}</option>
          {INQUIRY_STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {ko.catalog.inquiries.statusLabels[status]}
            </option>
          ))}
        </Select>
      </header>

      {showError ? (
        <div className="px-4 pt-4">
          <PageError message={ko.catalog.inquiries.statusError} />
        </div>
      ) : null}

      {state === "loading" ? <PageSpinner /> : null}
      {state === "error" ? (
        <div className="p-4">
          <PageError message={ko.catalog.inquiries.error} onRetry={onRetry} />
        </div>
      ) : null}
      {state === "idle" && inquiries.length === 0 ? (
        <div className="p-4">
          <PageEmpty message={ko.catalog.inquiries.empty} />
        </div>
      ) : null}

      {state === "idle" && inquiries.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="border-b border-line bg-muted-panel text-xs uppercase tracking-wide text-steel">
              <tr>
                <th className="px-4 py-3 font-semibold">
                  {ko.catalog.inquiries.columns.name}
                </th>
                <th className="px-4 py-3 font-semibold">
                  {ko.catalog.inquiries.columns.phone}
                </th>
                <th className="px-4 py-3 font-semibold">
                  {ko.catalog.inquiries.columns.topic}
                </th>
                <th className="px-4 py-3 font-semibold">
                  {ko.catalog.inquiries.columns.location}
                </th>
                <th className="px-4 py-3 font-semibold">
                  {ko.catalog.inquiries.columns.message}
                </th>
                <th className="px-4 py-3 font-semibold">
                  {ko.catalog.inquiries.columns.status}
                </th>
                <th className="px-4 py-3 font-semibold">
                  {ko.catalog.inquiries.columns.createdAt}
                </th>
                <th className="px-4 py-3 text-right font-semibold">
                  {ko.catalog.inquiries.columns.actions}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {inquiries.map((inquiry) => {
                const busy = busyId === inquiry.id;
                return (
                  <tr key={inquiry.id} className="align-top hover:bg-muted-panel/50">
                    <td className="px-4 py-3 font-medium text-ink">
                      {inquiry.name}
                    </td>
                    <td className="px-4 py-3 text-steel">
                      <a
                        href={`tel:${inquiry.phone.replace(/[^0-9+]/g, "")}`}
                        className="text-brand-teal hover:underline"
                      >
                        {inquiry.phone}
                      </a>
                    </td>
                    <td className="px-4 py-3 text-steel">
                      {ko.catalog.inquiries.topicLabels[inquiry.topic]}
                    </td>
                    <td className="px-4 py-3 text-steel">
                      {inquiry.location ?? "—"}
                    </td>
                    <td className="max-w-xs px-4 py-3 text-steel">
                      <span className="line-clamp-2 block whitespace-pre-line">
                        {inquiry.message ?? "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Badge className={INQUIRY_BADGE[inquiry.status]}>
                        {ko.catalog.inquiries.statusLabels[inquiry.status]}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-steel">
                      {formatDate(inquiry.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {inquiry.status !== "CONTACTED" &&
                        inquiry.status !== "CLOSED" ? (
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            disabled={busy}
                            onClick={() => {
                              onSetStatus(inquiry, "CONTACTED");
                            }}
                          >
                            {ko.catalog.inquiries.markContacted}
                          </Button>
                        ) : null}
                        {inquiry.status !== "CLOSED" ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => {
                              onSetStatus(inquiry, "CLOSED");
                            }}
                          >
                            {ko.catalog.inquiries.markClosed}
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

function ListingFormDialog({
  form,
  editing,
  saving,
  saveError,
  onChange,
  onCancel,
  onSubmit,
}: {
  form: ListingForm;
  editing: boolean;
  saving: boolean;
  saveError: boolean;
  onChange: (form: ListingForm) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { api } = useAuth();
  // The equipment option chosen in this session, so the human label persists
  // for the selected id (the search endpoint is a per-query typeahead). When
  // editing an existing listing we only know the id, not its label.
  const [equipmentOption, setEquipmentOption] = useState<ComboboxOption>();

  function set<K extends keyof ListingForm>(key: K, value: ListingForm[K]) {
    onChange({ ...form, [key]: value });
  }

  const searchEquipment = useCallback(
    async (query: string): Promise<ComboboxOption[]> => {
      const response = await api
        .GET("/api/v1/equipment", { params: { query: { q: query, limit: 8 } } })
        .catch(() => undefined);
      return (response?.data?.items ?? []).map((item) => ({
        id: item.id,
        label: safeLabel(item.management_no, item.equipment_no),
        sublabel: [item.model, item.customer.name, item.site.name]
          .filter(Boolean)
          .join(" · "),
      }));
    },
    [api],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 sm:p-8">
      <Card className="w-full max-w-3xl p-0 shadow-xl">
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-lg font-semibold text-ink">
            {editing ? ko.catalog.form.editTitle : ko.catalog.form.createTitle}
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={ko.catalog.form.cancel}
            onClick={onCancel}
          >
            <X size={18} aria-hidden="true" />
          </Button>
        </header>

        <form
          className="grid gap-4 px-5 py-5 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <Field label={ko.catalog.form.modelNameLabel} className="sm:col-span-2">
            <Input
              value={form.model_name}
              required
              onChange={(event) => {
                set("model_name", event.target.value);
              }}
            />
          </Field>

          <Field label={ko.catalog.form.kindLabel}>
            <Select
              value={form.kind}
              onChange={(event) => {
                set("kind", event.target.value as ListingKind);
              }}
            >
              {KIND_OPTIONS.map((kind) => (
                <option key={kind} value={kind}>
                  {ko.catalog.kindLabels[kind]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={ko.catalog.form.conditionLabel}>
            <Select
              value={form.condition}
              onChange={(event) => {
                set("condition", event.target.value as ListingCondition);
              }}
            >
              {CONDITION_OPTIONS.map((condition) => (
                <option key={condition} value={condition}>
                  {ko.catalog.conditionLabels[condition]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={ko.catalog.form.listingTypeLabel}>
            <Select
              value={form.listing_type}
              onChange={(event) => {
                set("listing_type", event.target.value as ListingType);
              }}
            >
              {LISTING_TYPE_OPTIONS.map((type) => (
                <option key={type} value={type}>
                  {ko.catalog.listingTypeLabels[type]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={ko.catalog.form.capacityLabel}>
            <Input
              inputMode="numeric"
              value={form.capacity_milli}
              onChange={(event) => {
                set("capacity_milli", event.target.value);
              }}
            />
          </Field>

          <Field label={ko.catalog.form.modelYearLabel}>
            <Input
              inputMode="numeric"
              value={form.model_year}
              onChange={(event) => {
                set("model_year", event.target.value);
              }}
            />
          </Field>

          <Field label={ko.catalog.form.usageHoursLabel}>
            <Input
              inputMode="numeric"
              value={form.usage_hours}
              onChange={(event) => {
                set("usage_hours", event.target.value);
              }}
            />
          </Field>

          <Field label={ko.catalog.form.priceWonLabel}>
            <Input
              inputMode="numeric"
              value={form.price_won}
              onChange={(event) => {
                set("price_won", event.target.value);
              }}
            />
          </Field>

          <Field label={ko.catalog.form.statusLabel}>
            <Select
              value={form.status}
              onChange={(event) => {
                set("status", event.target.value as ListingStatus);
              }}
            >
              {STATUS_OPTIONS.map((status) => (
                <option key={status} value={status}>
                  {ko.catalog.statusLabels[status]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={ko.catalog.form.sortWeightLabel}>
            <Input
              inputMode="numeric"
              value={form.sort_weight}
              onChange={(event) => {
                set("sort_weight", event.target.value);
              }}
            />
          </Field>

          <Field label={ko.catalog.form.badgeLabel}>
            <Input
              value={form.badge}
              onChange={(event) => {
                set("badge", event.target.value);
              }}
            />
          </Field>

          <Field label={ko.catalog.form.availabilityLabel}>
            <Input
              value={form.availability}
              onChange={(event) => {
                set("availability", event.target.value);
              }}
            />
          </Field>

          <Field label={ko.catalog.form.usageLabelLabel}>
            <Input
              value={form.usage_label}
              onChange={(event) => {
                set("usage_label", event.target.value);
              }}
            />
          </Field>

          <Field label={ko.catalog.form.conditionLabelLabel}>
            <Input
              value={form.condition_label}
              onChange={(event) => {
                set("condition_label", event.target.value);
              }}
            />
          </Field>

          <Field label={ko.catalog.form.locationLabel}>
            <Input
              value={form.location}
              onChange={(event) => {
                set("location", event.target.value);
              }}
            />
          </Field>

          <div className="flex flex-col gap-1.5">
            <label
              className="text-sm font-medium text-ink"
              htmlFor="catalog-equipment-link"
            >
              {ko.catalog.form.equipmentLabel}
            </label>
            <AsyncCombobox
              id="catalog-equipment-link"
              search={searchEquipment}
              value={form.equipment_id}
              selectedOption={
                equipmentOption ??
                (form.equipment_id
                  ? {
                      id: form.equipment_id,
                      label: ko.catalog.form.equipmentLinked,
                    }
                  : undefined)
              }
              onChange={(v) => {
                set("equipment_id", v);
                if (!v) setEquipmentOption(undefined);
              }}
              onSelectOption={setEquipmentOption}
              placeholder={ko.catalog.form.equipmentPlaceholder}
            />
          </div>

          <Field label={ko.catalog.form.descriptionLabel} className="sm:col-span-2">
            <Textarea
              value={form.description}
              onChange={(event) => {
                set("description", event.target.value);
              }}
            />
          </Field>

          {saveError ? (
            <div className="sm:col-span-2">
              <PageError message={ko.catalog.form.saveError} />
            </div>
          ) : null}

          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button
              type="button"
              variant="secondary"
              onClick={onCancel}
              disabled={saving}
            >
              {ko.catalog.form.cancel}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? ko.catalog.form.saving : ko.catalog.form.save}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-sm font-medium text-ink">{label}</span>
      {children}
    </label>
  );
}
