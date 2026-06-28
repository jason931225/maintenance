import { Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { EquipmentListItem, EquipmentSortBy, EquipmentStatus } from "../api/types";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { PageEmpty } from "../components/states/PageEmpty";
import { PageError } from "../components/states/PageError";
import { SkeletonTable } from "../components/states/Skeleton";
import { PageHeader } from "../components/shell/PageHeader";
import { LoadMoreButton } from "../components/shell/LoadMoreButton";
import { EquipmentDetailDialog } from "../features/equipment/EquipmentDetailDialog";
import { useAuth } from "../context/auth";
import { hasAnyRole, ROLES } from "../components/shell/nav";
import { formatKoreanDate } from "../lib/datetime";
import { safeLabel } from "../lib/utils";
import { ko } from "../i18n/ko";

/** EquipmentManage holders — controls whether the edit action is shown. */
const EQUIPMENT_MANAGE_ROLES = [
  ROLES.ADMIN,
  ROLES.EXECUTIVE,
  ROLES.SUPER_ADMIN,
] as const;

const STATUS_OPTIONS: EquipmentStatus[] = [
  "rented",
  "spare",
  "disposed",
  "replacement",
  "sold",
];

const SORT_OPTIONS: { value: EquipmentSortBy; label: string }[] = [
  { value: "equipment_no", label: ko.equipment.browse.sortEquipmentNo },
  { value: "model", label: ko.equipment.browse.sortModel },
  { value: "customer", label: ko.equipment.browse.sortCustomer },
  { value: "updated_at", label: ko.equipment.browse.sortUpdatedAt },
];

const PAGE_LIMIT = 50;

type ReadState = "idle" | "loading" | "loading-more" | "error";

function statusLabel(status: EquipmentStatus): string {
  // All EquipmentStatus values have a defined entry in statuses; no ?? fallback needed.
  return ko.equipment.statuses[status];
}

function statusClassName(status: EquipmentStatus): string {
  switch (status) {
    case "rented":
      return "bg-signal/10 text-signal border-signal/30";
    case "spare":
      return "bg-muted-panel text-steel border-line";
    case "disposed":
      return "bg-red-50 text-red-700 border-red-200";
    default:
      return "";
  }
}

function resetPagination(
  setItems: React.Dispatch<React.SetStateAction<EquipmentListItem[]>>,
  setOffset: React.Dispatch<React.SetStateAction<number>>,
  setTotal: React.Dispatch<React.SetStateAction<number | undefined>>,
) {
  setItems([]);
  setOffset(0);
  setTotal(undefined);
}

interface EquipmentBrowseSurfaceProps {
  showHeader?: boolean;
}

export function EquipmentBrowseSurface({
  showHeader = true,
}: EquipmentBrowseSurfaceProps = {}) {
  const { api, session } = useAuth();
  const canManage = hasAnyRole(session?.roles, EQUIPMENT_MANAGE_ROLES);

  // The equipment row whose detail popup is open, if any.
  const [detailItem, setDetailItem] = useState<EquipmentListItem | undefined>(
    undefined,
  );

  // Filter / sort state
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<EquipmentStatus | "">("");
  const [sort, setSort] = useState<EquipmentSortBy>("equipment_no");

  // Pagination state
  const [items, setItems] = useState<EquipmentListItem[]>([]);
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [offset, setOffset] = useState(0);
  const [readState, setReadState] = useState<ReadState>("loading");

  // Stale-request guard
  const ignoreRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchPage = useCallback(
    async (newOffset: number, append: boolean) => {
      if (!append) {
        setReadState("loading");
        ignoreRef.current = false;
      } else {
        setReadState("loading-more");
      }

      const res = await api
        .GET("/api/v1/equipment/list", {
          params: {
            query: {
              limit: PAGE_LIMIT,
              offset: newOffset,
              sort,
              ...(q.trim() ? { q: q.trim() } : {}),
              ...(status ? { status } : {}),
            },
          },
        })
        .catch(() => undefined);

      if (ignoreRef.current) return;

      if (!res?.data) {
        setReadState("error");
        return;
      }

      const page = res.data;
      setTotal(page.total);
      setOffset(newOffset + page.items.length);
      if (append) {
        setItems((prev) => [...prev, ...page.items]);
      } else {
        setItems(page.items);
      }
      setReadState("idle");
    },
    [api, q, status, sort],
  );

  // Initial + filter-change load (debounced on q; immediate on status/sort).
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    ignoreRef.current = true;

    debounceRef.current = setTimeout(() => {
      resetPagination(setItems, setOffset, setTotal);
      void fetchPage(0, false);
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, status, sort]);

  function handleLoadMore() {
    void fetchPage(offset, true);
  }

  function handleRetry() {
    resetPagination(setItems, setOffset, setTotal);
    void fetchPage(0, false);
  }

  function handleRowOpen(item: EquipmentListItem) {
    setDetailItem(item);
  }

  // Reflect an in-dialog edit onto the list row without a full refetch, and keep
  // the dialog open on the freshly-updated row.
  function handleRowUpdated(updated: EquipmentListItem) {
    setItems((prev) =>
      prev.map((row) =>
        row.equipment_id === updated.equipment_id ? updated : row,
      ),
    );
    setDetailItem(updated);
  }

  const hasMore = total !== undefined && items.length < total;

  return (
    <>
      {showHeader ? (
        <PageHeader
          title={ko.equipment.browse.title}
          description={ko.equipment.browse.description}
        />
      ) : null}

      {/* Filter bar */}
      <div className="mb-4 flex flex-wrap gap-3">
        {/* Search */}
        <div className="relative min-w-56 flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-steel"
          />
          <Input
            type="search"
            value={q}
            onChange={(e) => { setQ(e.target.value); }}
            placeholder={ko.equipment.browse.searchPlaceholder}
            aria-label={ko.equipment.browse.searchPlaceholder}
            className="pl-9"
          />
        </div>

        {/* Status filter */}
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value as EquipmentStatus | ""); }}
          aria-label={ko.equipment.browse.filterStatus}
          className="min-h-10 rounded border border-line bg-white px-3 py-2 text-sm text-ink outline-none transition focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
        >
          <option value="">{ko.equipment.browse.filterStatusAll}</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
            </option>
          ))}
        </select>

        {/* Sort */}
        <select
          value={sort}
          onChange={(e) => { setSort(e.target.value as EquipmentSortBy); }}
          aria-label={ko.equipment.browse.filterSort}
          className="min-h-10 rounded border border-line bg-white px-3 py-2 text-sm text-ink outline-none transition focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Table surface */}
      {readState === "error" ? (
        <PageError message={ko.equipment.browse.loadFailed} onRetry={handleRetry} />
      ) : readState === "loading" ? (
        <SkeletonTable rows={8} cols={7} />
      ) : items.length === 0 ? (
        <PageEmpty message={ko.equipment.browse.empty} />
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-white">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-muted-panel/40 text-left text-steel">
                  <th className="px-4 py-3 font-medium">
                    {ko.equipment.browse.colEquipmentNo}
                  </th>
                  <th className="px-4 py-3 font-medium">
                    {ko.equipment.browse.colManagementNo}
                  </th>
                  <th className="px-4 py-3 font-medium">
                    {ko.equipment.browse.colStatus}
                  </th>
                  <th className="px-4 py-3 font-medium">
                    {ko.equipment.browse.colModel}
                  </th>
                  <th className="px-4 py-3 font-medium">
                    {ko.equipment.browse.colCustomer}
                  </th>
                  <th className="px-4 py-3 font-medium">
                    {ko.equipment.browse.colUpdatedAt}
                  </th>
                  <th className="px-4 py-3 font-medium">
                    <span className="sr-only">
                      {ko.equipment.browse.rowAction}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((item) => (
                  <tr
                    key={item.equipment_id}
                    role="button"
                    tabIndex={0}
                    aria-label={`${ko.equipment.browse.rowAction}: ${item.equipment_no}`}
                    className="cursor-pointer hover:bg-muted-panel/30 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal"
                    onClick={() => { handleRowOpen(item); }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        handleRowOpen(item);
                      }
                    }}
                  >
                    <td className="px-4 py-3 font-mono text-xs font-medium text-ink">
                      {item.equipment_no}
                    </td>
                    <td className="px-4 py-3 text-steel">
                      {item.management_no ?? ko.common.notSet}
                    </td>
                    <td className="px-4 py-3">
                      <Badge className={statusClassName(item.status)}>
                        {statusLabel(item.status)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-ink">
                      {safeLabel(item.model, item.maker)}
                    </td>
                    <td className="px-4 py-3 text-ink">
                      <span className="font-medium">
                        {safeLabel(item.customer_name)}
                      </span>
                      <span className="mx-1 text-steel">/</span>
                      <span className="text-steel">
                        {safeLabel(item.site_name)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-steel">
                      {formatKoreanDate(item.updated_at)}
                    </td>
                    <td className="px-4 py-3">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(event) => {
                          // The row already opens the popup; stop the bubble so
                          // we don't fire the row handler a second time.
                          event.stopPropagation();
                          handleRowOpen(item);
                        }}
                        aria-label={`${
                          canManage
                            ? ko.equipment.browse.editAction
                            : ko.equipment.browse.viewAction
                        }: ${item.equipment_no}`}
                      >
                        {canManage
                          ? ko.equipment.browse.editAction
                          : ko.equipment.browse.viewAction}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {hasMore ? (
            <div className="border-t border-line p-4">
              <LoadMoreButton
                onClick={handleLoadMore}
                isLoading={readState === "loading-more"}
                loaded={items.length}
                total={total}
              />
            </div>
          ) : null}
        </div>
      )}

      <EquipmentDetailDialog
        // Remount per row so the dialog always opens on the read-only view with
        // form fields freshly seeded from the selected equipment.
        key={detailItem?.equipment_id ?? "closed"}
        item={detailItem}
        canManage={canManage}
        api={api}
        referenceItems={items}
        onClose={() => { setDetailItem(undefined); }}
        onUpdated={handleRowUpdated}
      />
    </>
  );
}

export function EquipmentBrowsePage() {
  return <EquipmentBrowseSurface />;
}
