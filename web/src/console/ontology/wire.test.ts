import { describe, expect, it } from "vitest";

import type { ObjectTypeDetailWire } from "../../api/ontology";
import type { OntObjectTypeDef } from "./types";
import {
  displayValue,
  objectCardDescriptorFrom,
  objectTypeDefFromDetail,
  stagedRevisionDraft,
} from "./wire";

describe("displayValue money formatting", () => {
  it("renders a money-typed won integer with the shared ₩ helper (§4-18), never raw", () => {
    // The inspector regression: a `money` property was leaking "36000000".
    expect(displayValue(36_000_000, "money")).toBe("₩36,000,000");
    expect(displayValue(1_860_000, "money")).toBe("₩1,860,000");
    // Numeric strings on the wire coerce and format too.
    expect(displayValue("36000000", "money")).toBe("₩36,000,000");
  });

  it("falls through for a non-numeric or already-formatted money value (never ₩NaN)", () => {
    expect(displayValue("₩1,860,000", "money")).toBe("₩1,860,000");
    expect(displayValue("협의", "money")).toBe("협의");
  });

  it("leaves non-money types untouched and preserves deny-by-omission for null", () => {
    expect(displayValue("NK보안", "text")).toBe("NK보안");
    expect(displayValue(null, "money")).toBeNull();
    expect(displayValue(undefined, "money")).toBeNull();
  });
});

describe("displayValue number formatting", () => {
  it("renders number/integer/decimal with plain ko-KR separators (no ₩), never raw", () => {
    // The inspector regression: a `number` property was leaking "36000000".
    expect(displayValue(36_000_000, "number")).toBe("36,000,000");
    expect(displayValue(36_000_000, "integer")).toBe("36,000,000");
    expect(displayValue(1234.5, "decimal")).toBe("1,234.5");
    // Numeric strings on the wire coerce and format too.
    expect(displayValue("1860000", "number")).toBe("1,860,000");
  });

  it("falls through for a non-numeric number value and leaves non-numeric kinds raw", () => {
    expect(displayValue("협의", "number")).toBe("협의");
    // percent/choice/text are not numeric kinds — untouched.
    expect(displayValue(74, "percent")).toBe("74");
    expect(displayValue(true, "boolean")).toBe("true");
  });
});

describe("analytic formula wire canonicalization", () => {
  it("round-trips a newly authored expression without converting it to empty JSON", () => {
    const detail = {
      object_type: {
        id: "type-1",
        stable_key: "work_order",
        title: "Work order",
        backing_kind: "instance",
        schema_version: 1,
        lifecycle_state: "draft",
      },
      title_property_key: null,
      backing_table: null,
      primary_key_property: null,
      properties: [],
      links: [],
      actions: [],
      analytics: [],
    } satisfies ObjectTypeDetailWire;
    const staged: OntObjectTypeDef = {
      id: "type-1",
      stableKey: "work_order",
      code: "work_order",
      title: "Work order",
      backingKind: "instance",
      schemaVersion: 1,
      lifecycleState: "draft",
      properties: [],
      links: [],
      actions: [],
      analytics: [
        {
          key: "analytic_00000000000040008000000000000001",
          title: "Delay days",
          formula: "days_between(due_date, now())",
        },
      ],
      instances: [],
      acting: [],
    };

    const request = stagedRevisionDraft(detail, staged, new Map());
    expect(request.analytics).toEqual([
      {
        key: "analytic_00000000000040008000000000000001",
        title: "Delay days",
        formula: { expression: "days_between(due_date, now())" },
      },
    ]);

    const formula = request.analytics?.[0]?.formula;
    const reloaded = objectTypeDefFromDetail(
      {
        ...detail,
        analytics: [
          {
            id: "analytic-id",
            key: "analytic_00000000000040008000000000000001",
            title: "Delay days",
            formula,
            result_type: {},
          },
        ],
      },
      [],
      new Map(),
    );
    expect(reloaded.analytics[0]?.formula).toBe(
      "days_between(due_date, now())",
    );
  });
});

describe("object card descriptor wire identity", () => {
  it("preserves the real object-type UUID for governed action preflight and execute", () => {
    const detail = {
      object_type: {
        id: "11111111-1111-4111-8111-111111111111",
        stable_key: "work_order",
        title: "작업지시",
        backing_kind: "instance",
        schema_version: 1,
        lifecycle_state: "published",
      },
      title_property_key: null,
      backing_table: null,
      primary_key_property: null,
      properties: [],
      links: [],
      actions: [],
      analytics: [],
    } satisfies ObjectTypeDetailWire;
    const descriptor = objectCardDescriptorFrom({
      state: {
        instance: {
          id: "instance-1",
          object_type_id: detail.object_type.id,
          title: "WO-1",
          current_revision_id: null,
          lifecycle_state: "active",
        },
        revision: {
          id: "revision-1",
          instance_id: "instance-1",
          version: 1,
          attributes: {},
          valid_from: "2026-07-23T00:00:00Z",
          valid_to: null,
          action_type_id: null,
          actor: null,
          reason: null,
          prev_hash: "0".repeat(64),
          row_hash: "1".repeat(64),
        },
      },
      history: [],
      detail,
    });

    expect(descriptor.objectType).toEqual({
      id: detail.object_type.id,
      key: "work_order",
      title: "작업지시",
    });
  });
});
