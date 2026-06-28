import type { KeyboardEvent, ReactNode } from "react";

import { cn } from "../../lib/utils";

export type DataTableColumn<T> = {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  headerClassName?: string;
  cellClassName?: string;
};

type DataTableProps<T> = {
  rows: T[];
  columns: Array<DataTableColumn<T>>;
  getRowKey: (row: T) => string;
  getRowAriaLabel?: (row: T) => string;
  onRowClick?: (row: T) => void;
  footer?: ReactNode;
};

const INTERACTIVE_DESCENDANT_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function isFromInteractiveDescendant(event: KeyboardEvent<HTMLTableRowElement>) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  const interactive = target.closest(INTERACTIVE_DESCENDANT_SELECTOR);
  return interactive !== null && interactive !== event.currentTarget;
}

export function DataTable<T>({
  rows,
  columns,
  getRowKey,
  getRowAriaLabel,
  onRowClick,
  footer,
}: DataTableProps<T>) {
  const clickable = onRowClick !== undefined;

  function openRow(row: T) {
    onRowClick?.(row);
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, row: T) {
    if (!clickable) return;
    if (isFromInteractiveDescendant(event)) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openRow(row);
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-white">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-muted-panel/40 text-left text-steel">
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={cn("px-4 py-3 font-medium", column.headerClassName)}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row) => (
              <tr
                key={getRowKey(row)}
                role={clickable ? "button" : undefined}
                tabIndex={clickable ? 0 : undefined}
                aria-label={getRowAriaLabel?.(row)}
                className={cn(
                  clickable &&
                    "cursor-pointer hover:bg-muted-panel/30 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal",
                )}
                onClick={clickable ? () => { openRow(row); } : undefined}
                onKeyDown={
                  clickable ? (event) => { handleRowKeyDown(event, row); } : undefined
                }
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn("px-4 py-3", column.cellClassName)}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer}
    </div>
  );
}
