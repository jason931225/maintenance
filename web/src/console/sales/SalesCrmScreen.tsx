import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  CustomerInquiryPage,
  CustomerInquiryView,
  InquiryStatus,
  SalesListingPage,
  SalesListingView,
} from "../../api/types";
import type { ConsoleApiClient } from "../../api/client";
import { salesCrm as S } from "../../i18n/salesCrm";
import "./sales.css";

type StreamState = "loading" | "ready" | "stale-error" | "error" | "denied";
type InboxFilter = "ALL" | InquiryStatus;
const PAGE_SIZE = 50;

const INBOX_FILTERS: ReadonlyArray<{ value: InboxFilter; label: string }> = [
  { value: "ALL", label: S.filterAll },
  { value: "NEW", label: S.inquiryNew },
  { value: "CONTACTED", label: S.inquiryContacted },
  { value: "CLOSED", label: S.inquiryClosed },
];

const NEXT_STATUS: Record<InquiryStatus, InquiryStatus | undefined> = {
  NEW: "CONTACTED",
  CONTACTED: "CLOSED",
  CLOSED: undefined,
};

function dateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function statusLabel(status: InquiryStatus): string {
  return ({ NEW: S.inquiryNew, CONTACTED: S.inquiryContacted, CLOSED: S.inquiryClosed })[status];
}

function listingStatusLabel(status: SalesListingView["status"]): string {
  return (
    {
      DRAFT: S.listingDraft,
      PUBLISHED: S.listingPublished,
      RESERVED: S.listingReserved,
      SOLD: S.listingSold,
      WITHDRAWN: S.listingWithdrawn,
    } as const
  )[status];
}

function listingKindLabel(kind: SalesListingView["kind"]): string {
  return ({ ELECTRIC: S.kindElectric, DIESEL: S.kindDiesel, LPG: S.kindLpg, REACH: S.kindReach } as const)[kind];
}

function listingPrice(price: number | null): string {
  return price === null ? S.priceOnRequest : `₩${price.toLocaleString("ko-KR")}`;
}

function errorKind(result: { response?: Response; error?: unknown }): "denied" | "error" {
  return result.response?.status === 401 || result.response?.status === 403 ? "denied" : "error";
}

/**
 * Authenticated sales workbench. It deliberately represents the data that the
 * sales domain actually owns today: org-level equipment listings and inbound
 * public inquiries. It does not invent a customer master, opportunity pipeline,
 * quote, owner assignment, or branch scope that the backend does not expose.
 */
export function SalesCrmScreen({ api }: { api: ConsoleApiClient }) {
  const [catalogState, setCatalogState] = useState<StreamState>("loading");
  const [inboxState, setInboxState] = useState<StreamState>("loading");
  const [listings, setListings] = useState<SalesListingView[]>([]);
  const [inquiries, setInquiries] = useState<CustomerInquiryView[]>([]);
  const [listingsTotal, setListingsTotal] = useState(0);
  const [inquiriesTotal, setInquiriesTotal] = useState(0);
  const [selectedInquiryId, setSelectedInquiryId] = useState<string>();
  const [filter, setFilter] = useState<InboxFilter>("ALL");
  const [busyId, setBusyId] = useState<string>();
  const [busyApi, setBusyApi] = useState<ConsoleApiClient>();
  const [listingsPending, setListingsPending] = useState(false);
  const [inquiriesPending, setInquiriesPending] = useState(false);
  const [actionErrorId, setActionErrorId] = useState<string>();
  const viewGeneration = useRef(0);
  const mounted = useRef(false);
  const apiRef = useRef(api);
  const filterRef = useRef<InboxFilter>("ALL");
  const listingRequestOwner = useRef(0);
  const inquiryRequestOwner = useRef(0);
  const inboxDataVersion = useRef(0);
  const inboxDenied = useRef(false);
  const terminalDenied = useRef(false);
  const listingsPendingRef = useRef(false);
  const inquiriesPendingRef = useRef(false);
  const operationOwner = useRef(new Map<string, number>());
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const listingsRef = useRef<SalesListingView[]>([]);
  const inquiriesRef = useRef<CustomerInquiryView[]>([]);
  apiRef.current = api;

  const selectedInquiry = useMemo(
    () => inquiries.find((inquiry) => inquiry.id === selectedInquiryId),
    [inquiries, selectedInquiryId],
  );
  const selectedNextStatus = selectedInquiry ? NEXT_STATUS[selectedInquiry.status] : undefined;
  const mutationPending = Boolean(busyId && busyApi === api);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const latchTerminalDenied = useCallback(() => {
    terminalDenied.current = true;
    inboxDenied.current = true;
    if (mounted.current) setInboxState("denied");
  }, []);

  const selectInquiry = useCallback((id: string, focus = false) => {
    setSelectedInquiryId(id);
    if (focus) queueMicrotask(() => rowRefs.current.get(id)?.focus());
  }, []);

  const loadListings = useCallback(async (append = false, bypassCache = false, force = false) => {
    const generation = viewGeneration.current;
    const listingOffset = append ? listingsRef.current.length : 0;
    if (listingsPendingRef.current && !force) return;
    const owner = ++listingRequestOwner.current;
    listingsPendingRef.current = true;
    setListingsPending(true);
    if (!append && !terminalDenied.current) setCatalogState("loading");
    try {
      const listingResult = await api.GET("/api/v1/sales/listings", {
        params: { query: { limit: PAGE_SIZE, offset: listingOffset } },
        ...(bypassCache ? { headers: { "Cache-Control": "no-cache" } } : {}),
      });
      if (errorKind(listingResult) === "denied") { latchTerminalDenied(); return; }
      if (terminalDenied.current || generation !== viewGeneration.current || owner !== listingRequestOwner.current) return;
      if (!listingResult.data) {
        const failure = errorKind(listingResult);
        setCatalogState(failure === "denied" ? "denied" : listingsRef.current.length === 0 ? "error" : "stale-error");
        return;
      }
      const listingPage: SalesListingPage = listingResult.data;
      const nextListings = append ? [...listingsRef.current, ...listingPage.items] : listingPage.items;
      listingsRef.current = nextListings;
      setListings(nextListings);
      setListingsTotal(listingPage.total);
      setCatalogState("ready");
    } catch {
      if (!terminalDenied.current && generation === viewGeneration.current && owner === listingRequestOwner.current) {
        setCatalogState(listingsRef.current.length === 0 ? "error" : "stale-error");
      }
    } finally {
      if (generation === viewGeneration.current && owner === listingRequestOwner.current) { listingsPendingRef.current = false; setListingsPending(false); }
    }
  }, [api, latchTerminalDenied]);

  const loadInquiries = useCallback(async (append = false, bypassCache = false, force = false) => {
    const generation = viewGeneration.current;
    const dataVersion = inboxDataVersion.current;
    const inquiryOffset = append ? inquiriesRef.current.length : 0;
    if (inquiriesPendingRef.current && !force) return;
    const owner = ++inquiryRequestOwner.current;
    inquiriesPendingRef.current = true;
    setInquiriesPending(true);
    if (!append && !terminalDenied.current) setInboxState("loading");
    try {
      const inquiryResult = await api.GET("/api/v1/sales/inquiries", {
        params: { query: { limit: PAGE_SIZE, offset: inquiryOffset, ...(filterRef.current === "ALL" ? {} : { status: filterRef.current }) } },
        ...(bypassCache ? { headers: { "Cache-Control": "no-cache" } } : {}),
      });
      if (errorKind(inquiryResult) === "denied") { latchTerminalDenied(); return; }
      if (terminalDenied.current || generation !== viewGeneration.current || owner !== inquiryRequestOwner.current || dataVersion !== inboxDataVersion.current || inboxDenied.current) return;
      if (!inquiryResult.data) {
        const failure = errorKind(inquiryResult);
        setInboxState(inquiriesRef.current.length === 0 ? "error" : "stale-error");
        return;
      }
      const inquiryPage: CustomerInquiryPage = inquiryResult.data;
      const nextInquiries = append ? [...inquiriesRef.current, ...inquiryPage.items] : inquiryPage.items;
      inquiriesRef.current = nextInquiries;
      setInquiries(nextInquiries);
      setInquiriesTotal(inquiryPage.total);
      setSelectedInquiryId((current) => nextInquiries.some((item) => item.id === current) ? current : nextInquiries[0]?.id);
      setInboxState("ready");
    } catch {
      if (!terminalDenied.current && generation === viewGeneration.current && owner === inquiryRequestOwner.current && dataVersion === inboxDataVersion.current) {
        setInboxState(inquiriesRef.current.length === 0 ? "error" : "stale-error");
      }
    } finally {
      if (generation === viewGeneration.current && owner === inquiryRequestOwner.current) { inquiriesPendingRef.current = false; setInquiriesPending(false); }
    }
  }, [api, latchTerminalDenied]);

  const refresh = useCallback(async (bypassCache = false) => {
    if (terminalDenied.current) return;
    setCatalogState("loading");
    setInboxState("loading");
    await Promise.all([loadListings(false, bypassCache, true), loadInquiries(false, bypassCache, true)]);
  }, [loadInquiries, loadListings]);

  const changeFilter = useCallback((nextFilter: InboxFilter) => {
    if (nextFilter === filter) return;
    inquiriesRef.current = [];
    setInquiries([]);
    setInquiriesTotal(0);
    setSelectedInquiryId(undefined);
    if (!terminalDenied.current) setInboxState("loading");
    filterRef.current = nextFilter;
    setFilter(nextFilter);
    void loadInquiries(false, false, true);
  }, [filter, loadInquiries]);

  useEffect(() => {
    const generation = ++viewGeneration.current;
    let active = true;
    queueMicrotask(() => {
      if (!active || !mounted.current || generation !== viewGeneration.current || terminalDenied.current) return;
      void refresh(false);
    });
    return () => {
      active = false;
      if (viewGeneration.current === generation) viewGeneration.current += 1;
    };
  }, [refresh]);

  const advanceInquiry = useCallback(
    async (inquiry: CustomerInquiryView) => {
      const next = NEXT_STATUS[inquiry.status];
      if (!next || (busyId && busyApi === api)) return;
      const generation = viewGeneration.current;
      const requestApi = api;
      const owner = (operationOwner.current.get(inquiry.id) ?? 0) + 1;
      let committed = false;
      operationOwner.current.set(inquiry.id, owner);
      setBusyId(inquiry.id);
      setBusyApi(api);
      setActionErrorId(undefined);
      try {
        const result = await api.PATCH("/api/v1/sales/inquiries/{id}", {
          params: { path: { id: inquiry.id } },
          body: { status: next },
        });
        if (errorKind(result) === "denied") { latchTerminalDenied(); return; }
        const ownsCurrentView = mounted.current && apiRef.current === requestApi && generation === viewGeneration.current && operationOwner.current.get(inquiry.id) === owner && !terminalDenied.current;
        if (!ownsCurrentView) return;
        if (result.error || !result.response.ok) {
          setActionErrorId(inquiry.id);
          return;
        }
        inboxDataVersion.current += 1;
        committed = true;
        if (!mounted.current) return;
        const nextInquiries = inquiriesRef.current.map((item) => item.id === inquiry.id ? { ...item, status: next } : item);
        inquiriesRef.current = nextInquiries;
        setInquiries(nextInquiries);
      } catch {
        if (!terminalDenied.current && mounted.current && apiRef.current === requestApi && generation === viewGeneration.current && operationOwner.current.get(inquiry.id) === owner) setActionErrorId(inquiry.id);
      } finally {
        if (!terminalDenied.current && mounted.current && apiRef.current === requestApi && generation === viewGeneration.current && operationOwner.current.get(inquiry.id) === owner) {
          setBusyId(undefined);
          setBusyApi(undefined);
          if (committed) void loadInquiries(false, true, true);
        }
      }
    },
    [api, busyApi, busyId, latchTerminalDenied, loadInquiries],
  );

  if (catalogState === "denied" || inboxState === "denied") {
    return <section aria-label={S.operationalLabel} className="sales-state">{S.denied}</section>;
  }

  return (
    <section aria-label={S.operationalLabel} className="sales-screen console">
      <section aria-labelledby="sales-catalog-heading" className="sales-panel">
        <header className="sales-panel-header">
          <p className="sales-kicker">{S.catalogKicker}</p>
          <h1 id="sales-catalog-heading" className="sales-title">{S.catalogTitle}</h1>
          <p className="sales-muted">{S.catalogDescription}</p>
        </header>
        {catalogState === "loading" ? <p className="sales-state" role="status">{listings.length === 0 ? S.listingsLoading : S.listingsRefreshing}</p> : null}
        {catalogState === "error" ? <div className="sales-load-error" role="alert"><p>{S.catalogLoadFailed}</p><button type="button" onClick={() => { void loadListings(false, true, true); }} className="sales-refresh">{S.retry}</button></div> : null}
        {catalogState === "stale-error" ? <div className="sales-load-error" role="alert"><p>{S.catalogStale}</p><button type="button" onClick={() => { void loadListings(false, true, true); }} className="sales-refresh">{S.retry}</button></div> : null}
        {catalogState === "ready" && listings.length === 0 ? <p className="sales-state">{S.listingsEmpty}</p> : null}
        <ul className="sales-list" aria-label={S.listingsLabel}>
          {listings.map((listing) => (
            <li key={listing.id} className="sales-listing">
              <div className="sales-row-head"><strong className="sales-row-title">{listing.model_name}</strong><span className="sales-status">{listingStatusLabel(listing.status)}</span></div>
              <p className="sales-row-meta">{listingKindLabel(listing.kind)} · {listing.condition === "USED" ? S.used : S.new} · {listingPrice(listing.price_won)}</p>
              <p className="sales-row-subtle">{listing.location ?? S.locationMissing}</p>
            </li>
          ))}
        </ul>
        {listings.length < listingsTotal ? <button type="button" disabled={listingsPending} className="sales-load-more" onClick={() => { void loadListings(true); }}>{S.loadMore}</button> : null}
      </section>

      <section aria-labelledby="sales-inbox-heading" className="sales-panel">
        <header className="sales-panel-header">
          <div className="sales-row-head"><div><p className="sales-kicker">{S.inboxKicker}</p><h2 id="sales-inbox-heading" className="sales-title">{S.inquiriesTitle}</h2></div><button type="button" onClick={() => { void refresh(true); }} className="sales-refresh">{S.refresh}</button></div>
          <div className="sales-filters" role="group" aria-label={S.inquiryFilter}>
            {INBOX_FILTERS.map((item) => <button key={item.value} type="button" aria-pressed={filter === item.value} onClick={() => { changeFilter(item.value); }} className={filter === item.value ? "sales-filter sales-filter-active" : "sales-filter"}>{item.label}</button>)}
          </div>
        </header>
        {inboxState === "loading" ? <p className="sales-state" role="status">{inquiries.length === 0 ? S.inquiriesLoading : S.inquiriesRefreshing}</p> : null}
        {inboxState === "error" ? <div className="sales-load-error" role="alert"><p>{S.inquiriesLoadFailed}</p><button type="button" onClick={() => { void loadInquiries(false, true, true); }} className="sales-refresh">{S.retry}</button></div> : null}
        {inboxState === "stale-error" ? <div className="sales-load-error" role="alert"><p>{S.inquiriesStale}</p><button type="button" onClick={() => { void loadInquiries(false, true, true); }} className="sales-refresh">{S.retry}</button></div> : null}
        {inboxState === "ready" && inquiries.length === 0 ? <p className="sales-state">{S.inquiriesEmpty}</p> : null}
        <div role="listbox" aria-label={S.inquiriesLabel} className="sales-list">
          {inquiries.map((inquiry) => {
            const selected = inquiry.id === selectedInquiry?.id;
            return <button ref={(node) => { if (node) rowRefs.current.set(inquiry.id, node); else rowRefs.current.delete(inquiry.id); }} id={`sales-inquiry-${inquiry.id}`} key={inquiry.id} type="button" role="option" tabIndex={selected ? 0 : -1} aria-selected={selected} onClick={() => { selectInquiry(inquiry.id); }} onKeyDown={(event) => {
              const index = inquiries.findIndex((item) => item.id === inquiry.id);
              const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? inquiries.length - 1 : event.key === "ArrowDown" ? Math.min(index + 1, inquiries.length - 1) : event.key === "ArrowUp" ? Math.max(index - 1, 0) : index;
              if (nextIndex !== index || event.key === "Home" || event.key === "End") { event.preventDefault(); selectInquiry(inquiries[nextIndex].id, true); }
            }} className={selected ? "sales-inquiry sales-inquiry-selected" : "sales-inquiry"}>
              <span className="sales-row-head"><strong className="sales-row-title">{inquiry.name}</strong><span className="sales-status">{statusLabel(inquiry.status)}</span></span>
              <span className="sales-row-meta sales-block">{inquiry.topic} · {inquiry.location ?? S.locationNotEntered}</span>
              <span className="sales-row-subtle sales-block">{dateTime(inquiry.created_at)}</span>
            </button>;
          })}
        </div>
        {inquiries.length < inquiriesTotal ? <button type="button" disabled={inquiriesPending} className="sales-load-more" onClick={() => { void loadInquiries(true); }}>{S.loadMore}</button> : null}
      </section>

      <aside aria-label={S.detailLabel} className="sales-detail">
        {selectedInquiry ? <>
          <p className="sales-kicker">{S.detailKicker}</p>
          <h2 className="sales-title">{selectedInquiry.name}</h2>
          <dl className="sales-detail-list"><div><dt className="sales-detail-label">{S.contact}</dt><dd className="sales-detail-value">{selectedInquiry.phone}</dd></div><div><dt className="sales-detail-label">{S.topic}</dt><dd className="sales-detail-value">{selectedInquiry.topic}</dd></div><div><dt className="sales-detail-label">{S.linkedListing}</dt><dd className="sales-detail-id">{selectedInquiry.listing_id ?? S.noLinkedListing}</dd></div><div><dt className="sales-detail-label">{S.message}</dt><dd className="sales-detail-message">{selectedInquiry.message ?? S.noMessage}</dd></div></dl>
          {actionErrorId === selectedInquiry.id ? <div className="sales-action-error" role="alert"><span>{S.actionFailed}</span><button type="button" className="sales-refresh" onClick={() => { void advanceInquiry(selectedInquiry); }}>{S.actionRetry}</button></div> : null}
          {selectedNextStatus ? <button type="button" disabled={mutationPending} aria-describedby={mutationPending ? "sales-transition-pending" : undefined} onClick={() => { void advanceInquiry(selectedInquiry); }} className="sales-primary-action sales-advance">{mutationPending && busyId === selectedInquiry.id ? S.statusChanging : S.advanceStatus(statusLabel(selectedNextStatus))}</button> : <p className="sales-closed">{S.statusEnding}</p>}
          {mutationPending ? <p id="sales-transition-pending" role="status" className="sales-state">{S.statusChanging}</p> : null}
        </> : <p className="sales-state">{S.detailEmpty}</p>}
      </aside>
    </section>
  );
}
