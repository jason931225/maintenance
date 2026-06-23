import { Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import type { EquipmentListItem, EquipmentSortBy, EquipmentStatus } from "../api/types";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { PageEmpty } from "../components/states/PageEmpty";
import { PageError } from "../components/states/PageError";
import { SkeletonTable } from "../components/states/Skeleton";
import { PageHeader } from "../components/shell/PageHeader";
import { LoadMoreButton } from "../components/shell/LoadMoreButton";
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

export function EquipmentBrowsePage() {
  const { api, session } = useAuth();
  const navigate = useNavigate();
  const canManage = hasAnyRole(session?.roles, EQUIPMENT_MANAGE_ROLES);

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

  function handleEditClick(equipmentId: string) {
    void navigate(`/equipment/manage?id=${equipmentId}`);
  }

  const hasMore = total !== undefined && items.length < total;

  return (
    <>
      <PageHeader
        title={ko.equipment.browse.title}
        description={ko.equipment.browse.description}
      />

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
        <SkeletonTable rows={8} cols={canManage ? 7 : 6} />
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
                  {canManage ? (
                    <th className="px-4 py-3 font-medium">
                      <span className="sr-only">{ko.equipment.browse.editAction}</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((item) => (
                  <tr
                    key={item.equipment_id}
                    className="hover:bg-muted-panel/30"
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
                    {canManage ? (
                      <td className="px-4 py-3">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => { handleEditClick(item.equipment_id); }}
                          aria-label={`${ko.equipment.browse.editAction}: ${item.equipment_no}`}
                        >
                          {ko.equipment.browse.editAction}
                        </Button>
                      </td>
                    ) : null}
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
    </>
  );
}
