import type { components } from "@maintenance/api-client-ts";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { ko } from "../../i18n/ko";
import type { WorkOrderFilterState } from "./workOrderQuery";

type WorkOrderStatus = components["schemas"]["WorkOrderStatus"];
type PriorityLevel = components["schemas"]["PriorityLevel"];

const STATUSES = Object.keys(ko.status) as WorkOrderStatus[];
const PRIORITIES = Object.keys(ko.priority) as PriorityLevel[];

interface WorkOrderFiltersProps {
  value: WorkOrderFilterState;
  onChange: (next: WorkOrderFilterState) => void;
  onReset: () => void;
}

/**
 * Search/filter bar for the dispatch work-order list — the "I'm calling about
 * order 1234" path for receptionist + admin. The text box filters the loaded
 * rows by request_no / customer / equipment-no (client-side); status + priority
 * drive the existing list query params (`status[]` / `priority[]`) and re-fetch
 * from the server. No new backend params are invented.
 */
export function WorkOrderFilters({
  value,
  onChange,
  onReset,
}: WorkOrderFiltersProps) {
  const t = ko.dispatch.search;
  return (
    <Card className="grid gap-3">
      <h2 className="text-base font-semibold text-ink">{t.title}</h2>
      <div className="grid gap-3 md:grid-cols-[1.6fr_1fr_1fr_auto] md:items-end">
        <label className="grid gap-1 text-sm">
          <span className="font-medium text-steel">{t.label}</span>
          <Input
            type="search"
            value={value.query}
            placeholder={t.placeholder}
            onChange={(event) => {
              onChange({ ...value, query: event.currentTarget.value });
            }}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-medium text-steel">{t.statusLabel}</span>
          <Select
            value={value.status}
            onChange={(event) => {
              onChange({
                ...value,
                status: event.currentTarget.value as WorkOrderStatus | "",
              });
            }}
          >
            <option value="">{t.statusAll}</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {ko.status[status]}
              </option>
            ))}
          </Select>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-medium text-steel">{t.priorityLabel}</span>
          <Select
            value={value.priority}
            onChange={(event) => {
              onChange({
                ...value,
                priority: event.currentTarget.value as PriorityLevel | "",
              });
            }}
          >
            <option value="">{t.priorityAll}</option>
            {PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {ko.priority[priority]}
              </option>
            ))}
          </Select>
        </label>
        <Button type="button" variant="ghost" size="sm" onClick={onReset}>
          {t.reset}
        </Button>
      </div>
    </Card>
  );
}
