import { Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { EquipmentListItem, EquipmentSortBy, EquipmentStatus } from "../api/types";
import { ObjectLink } from "../components/object/ObjectLink";
import { Badge } from "../components/ui/badge";
import { DataTable, type DataTableColumn } from "../components/ui/data-table";
import { Input } from "../components/ui/input";
import { PageEmpty } from "../components/states/PageEmpty";
import { PageError } from "../components/states/PageError";
import { SkeletonTable } from "../components/states/Skeleton";
import { PageHeader } from "../components/shell/PageHeader";
import { LoadMoreButton } from "../components/shell/LoadMoreButton";
import { EquipmentDetailDialog } from "../features/equipment/EquipmentDetailDialog";
import { equipmentStatusBadgeClass } from "../features/equipment/equipment-format";
import { useAuth } from "../context/auth";
import { hasAnyRole, ROLES } from "../components/shell/nav";
import { formatKoreanDate } from "../lib/datetime";
import { Mono } from "../lib/format";
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

function equipmentColumns(
  canManage: boolean,
): Array<DataTableColumn<EquipmentListItem>> {
  const actionLabel = canManage
    ? ko.equipment.browse.editAction
    : ko.equipment.browse.viewAction;

  return [
    {
      key: "equipment_no",
      header: ko.equipment.browse.colEquipmentNo,
      cellClassName: "text-xs font-medium text-ink",
      cell: (item) => <Mono>{item.equipment_no}</Mono>,
    },
    {
      key: "management_no",
      header: ko.equipment.browse.colManagementNo,
      cellClassName: "text-steel",
      cell: (item) =>
        item.management_no ? <Mono>{item.management_no}</Mono> : ko.common.notSet,
    },
    {
      key: "status",
      header: ko.equipment.browse.colStatus,
      cell: (item) => (
        <Badge className={equipmentStatusBadgeClass(item.status)}>
          {statusLabel(item.status)}
        </Badge>
      ),
    },
    {
      key: "model",
      header: ko.equipment.browse.colModel,
      cellClassName: "text-ink",
      cell: (item) => safeLabel(item.model, item.maker),
    },
    {
      key: "customer",
      header: ko.equipment.browse.colCustomer,
      cellClassName: "text-ink",
      cell: (item) => (
        <>
          <span className="font-medium">{safeLabel(item.customer_name)}</span>
          <span className="mx-1 text-steel">/</span>
          <span className="text-steel">{safeLabel(item.site_name)}</span>
        </>
      ),
    },
    {
      key: "updated_at",
      header: ko.equipment.browse.colUpdatedAt,
      cellClassName: "text-steel",
      cell: (item) => formatKoreanDate(item.updated_at),
    },
    {
      key: "action",
      header: <span className="sr-only">{ko.equipment.browse.rowAction}</span>,
      cell: (item) => (
        <ObjectLink
          to={`/equipment/${item.equipment_id}`}
          state={{ equipment: item }}
          objectTypeLabel={ko.equipment.browse.objectType}
          objectLabel={item.equipment_no}
          ariaLabel={`${actionLabel}: ${item.equipment_no}`}
          className="px-2 py-1 text-steel no-underline hover:bg-muted-panel hover:text-ink hover:no-underline"
          onClick={(event) => {
            // The row still opens the legacy quick-view popup; stop bubbling so
            // this deep-link action navigates to the object page instead.
            event.stopPropagation();
          }}
        >
          {actionLabel}
        </ObjectLink>
      ),
    },
  ];
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
        <DataTable
          rows={items}
          columns={equipmentColumns(canManage)}
          getRowKey={(item) => item.equipment_id}
          getRowAriaLabel={(item) =>
            `${ko.equipment.browse.rowAction}: ${item.equipment_no}`
          }
          onRowClick={handleRowOpen}
          footer={
            hasMore ? (
              <div className="border-t border-line p-4">
                <LoadMoreButton
                  onClick={handleLoadMore}
                  isLoading={readState === "loading-more"}
                  loaded={items.length}
                  total={total}
                />
              </div>
            ) : null
          }
        />
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
