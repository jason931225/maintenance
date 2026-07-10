import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AssetLifecycleCostSummary, EquipmentListItem } from "../../api/types";
import { ko } from "../../i18n/ko";
import { ForecastScreen, type ForecastScreenProps } from "./ForecastScreen";
import { fcCode } from "./series";
import { forecastStrings } from "./strings";

const S = forecastStrings();
const T = ko.console.charts;

const equipment: EquipmentListItem = {
  equipment_id: "aaaa1111-bbbb-2222-cccc-333344445555",
  branch_id: "00000000-0000-4000-8000-000000000009",
  equipment_no: "FL-0042",
  status: "rented",
  specification: "3톤 지게차",
  ton_text: "3T",
  customer_name: "동해건설",
  site_name: "창원공장",
  updated_at: "2026-07-01T00:00:00Z",
};

const lifecycleCost: AssetLifecycleCostSummary = {
  equipment_id: equipment.equipment_id,
  equipment_no: equipment.equipment_no,
  status: "rented",
  acquisition_source: "EXPLICIT",
  maintenance_total_won: 600_000,
  manual_total_won: 600_000,
  purchase_total_won: 0,
  entry_count: 3,
  residual_value_won: 0,
  tco_won: 600_000,
  timeline: [
    {
      id: "1",
      branch_id: equipment.branch_id,
      equipment_id: equipment.equipment_id,
      work_order_id: null,
      purchase_request_id: null,
      source: "MANUAL_ADMIN",
      amount_won: 200_000,
      memo: "",
      residual_before_won: 0,
      residual_after_won: 0,
      entry_at: "2026-05-01T00:00:00Z",
    },
    {
      id: "2",
      branch_id: equipment.branch_id,
      equipment_id: equipment.equipment_id,
      work_order_id: null,
      purchase_request_id: null,
      source: "MANUAL_ADMIN",
      amount_won: 200_000,
      memo: "",
      residual_before_won: 0,
      residual_after_won: 0,
      entry_at: "2026-06-01T00:00:00Z",
    },
    {
      id: "3",
      branch_id: equipment.branch_id,
      equipment_id: equipment.equipment_id,
      work_order_id: null,
      purchase_request_id: null,
      source: "MANUAL_ADMIN",
      amount_won: 200_000,
      memo: "",
      residual_before_won: 0,
      residual_after_won: 0,
      entry_at: "2026-07-01T00:00:00Z",
    },
  ],
};

const NOW = new Date("2026-07-10T00:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

function baseProps(overrides: Partial<ForecastScreenProps> = {}): ForecastScreenProps {
  return {
    equipmentQuery: "",
    onEquipmentQueryChange: vi.fn(),
    equipmentOptions: [],
    selectedEquipment: undefined,
    onSelectEquipment: vi.fn(),
    onClearEquipment: vi.fn(),
    lifecycleCost: undefined,
    isLoading: false,
    horizonMonths: 3,
    onHorizonChange: vi.fn(),
    whatIfPct: 0,
    onWhatIfChange: vi.fn(),
    onDrill: vi.fn(),
    ...overrides,
  };
}

describe("ForecastScreen — equipment picker", () => {
  it("shows the empty reason before any search", () => {
    render(<ForecastScreen {...baseProps()} />);
    expect(screen.getByText(S.emptyReason)).toBeInTheDocument();
  });

  it("lists real search results and selects one on click", () => {
    const onSelectEquipment = vi.fn();
    render(
      <ForecastScreen
        {...baseProps({ equipmentQuery: "FL-0042", equipmentOptions: [equipment], onSelectEquipment })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /FL-0042/ }));
    expect(onSelectEquipment).toHaveBeenCalledWith(equipment);
  });

  it("shows the no-results chip for a query with zero matches", () => {
    render(<ForecastScreen {...baseProps({ equipmentQuery: "zzz", equipmentOptions: [] })} />);
    expect(screen.getByText(S.noResults)).toBeInTheDocument();
  });
});

describe("ForecastScreen — projection surface", () => {
  it("derives a real monthly sample from the cost ledger and renders the FC- code", () => {
    render(
      <ForecastScreen
        {...baseProps({ selectedEquipment: equipment, lifecycleCost, horizonMonths: 3 })}
      />,
    );
    expect(screen.getByText(fcCode(equipment.equipment_id))).toBeInTheDocument();
    // 3 real monthly buckets of 200,000 each -> deterministic point estimate.
    expect(screen.getByText(T.projection.assumptionN(3))).toBeInTheDocument();
  });

  it("shows the insufficient-sample state when the ledger has no entries in the horizon", () => {
    render(
      <ForecastScreen
        {...baseProps({
          selectedEquipment: equipment,
          lifecycleCost: { ...lifecycleCost, timeline: [] },
        })}
      />,
    );
    expect(screen.getByText(T.projection.insufficient)).toBeInTheDocument();
  });

  it("changing the horizon segment re-drives the sample (aria-pressed swap)", () => {
    const onHorizonChange = vi.fn();
    render(
      <ForecastScreen
        {...baseProps({ selectedEquipment: equipment, lifecycleCost, horizonMonths: 3, onHorizonChange })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: S.horizonMonths(12) }));
    expect(onHorizonChange).toHaveBeenCalledWith(12);
  });

  it("the what-if field is a typed number input that reports a numeric delta", () => {
    const onWhatIfChange = vi.fn();
    render(
      <ForecastScreen
        {...baseProps({ selectedEquipment: equipment, lifecycleCost, onWhatIfChange })}
      />,
    );
    fireEvent.change(screen.getByLabelText(S.whatIfLabel), { target: { value: "10" } });
    expect(onWhatIfChange).toHaveBeenCalledWith(10);
  });

  it("every projected number drills (§4-11)", () => {
    const onDrill = vi.fn();
    render(
      <ForecastScreen {...baseProps({ selectedEquipment: equipment, lifecycleCost, onDrill })} />,
    );
    // Constant 200,000/mo sample -> zero variance -> point = CI95 = CVaR95 = ₩200,000.
    fireEvent.click(screen.getByRole("button", { name: T.drill(T.projection.point, "₩200,000") }));
    expect(onDrill).toHaveBeenCalledWith("point");
  });

  it("change re-opens the picker", () => {
    const onClearEquipment = vi.fn();
    render(
      <ForecastScreen
        {...baseProps({ selectedEquipment: equipment, lifecycleCost, onClearEquipment })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: S.changeEquipment }));
    expect(onClearEquipment).toHaveBeenCalledTimes(1);
  });
});
