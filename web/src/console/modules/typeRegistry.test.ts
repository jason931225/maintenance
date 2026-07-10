import { describe, expect, it } from "vitest";

import type { ModuleRow } from "./types";
import { MOD_SCREENS } from "./moduleScreens";
import {
  ONT_TYPES,
  choiceStatus,
  columnVariantFor,
  detailVariantFor,
  getObjectType,
  getProperty,
  rowCardDescriptor,
  typeCardDescriptor,
  type OntProperty,
} from "./typeRegistry";

describe("typeRegistry", () => {
  it("defines every field the module screen configs consume (drift guard)", () => {
    for (const config of Object.values(MOD_SCREENS)) {
      const type = getObjectType(config.typeKey);
      expect(type, config.id).toBeDefined();
      for (const column of config.list.columns) {
        if (!column.labelKey) {
          expect(getProperty(type, column.key), `${config.id} column ${column.key}`).toBeDefined();
        }
      }
      for (const field of config.detail.fields) {
        if (!field.labelKey) {
          expect(getProperty(type, field.key), `${config.id} detail ${field.key}`).toBeDefined();
        }
      }
      if (config.list.laneGroupBy) {
        expect(getProperty(type, config.list.laneGroupBy)?.type).toBe("choice");
      }
    }
  });

  it("resolves choice values and degrades unknown values to a neutral raw chip", () => {
    expect(choiceStatus("equipment", "status", "rented")).toEqual({
      labelKey: "console.modules.asset.statuses.rented",
      tone: "ok",
    });
    expect(choiceStatus("equipment", "status", "hovering")).toEqual({
      labelKey: "hovering",
      tone: "neutral",
    });
    expect(choiceStatus("no_such_type", "status", "x")).toEqual({ labelKey: "x", tone: "neutral" });
  });

  it("derives render variants and degrades unknown field types to text, never crashing", () => {
    const type = getObjectType("equipment");
    expect(columnVariantFor(getProperty(type, "code"))).toBe("mono");
    expect(columnVariantFor(getProperty(type, "status"))).toBe("status");
    expect(columnVariantFor(getProperty(type, "links"))).toBe("linkChips");
    expect(columnVariantFor(getProperty(type, "model"))).toBe("text");
    expect(detailVariantFor(getProperty(type, "timeline"))).toBe("timeline");
    expect(detailVariantFor(getProperty(type, "graph"))).toBe("graph");
    expect(detailVariantFor(getProperty(type, "costLedger"))).toBe("ledger");
    // Field-schema forward-compat (arch §3c): unknown tags render as plain text.
    const unknown = { id: "hologram", nameKey: "x", type: "hologram" } as unknown as OntProperty;
    expect(columnVariantFor(unknown)).toBe("text");
    expect(detailVariantFor(unknown)).toBe("text");
    expect(columnVariantFor(undefined)).toBe("text");
  });

  it("builds the type card with schema, typed links, actions, and analytics", () => {
    const card = typeCardDescriptor(ONT_TYPES.equipment);
    expect(card.code).toBe("OT-EQUIPMENT");
    expect(card.title).toBe("장비");
    expect(card.properties.some((prop) => prop.key === "tco" && prop.type === "analytic")).toBe(true);
    expect(card.relations.find((rel) => rel.linkId === "equipment_cost")?.code).toBe("OT-FINANCE");
    expect(card.actions.map((action) => action.key)).toContain("updateProfile");
  });

  it("builds a row card from registry props, omitting absent values", () => {
    const row: ModuleRow = {
      id: "eq-1",
      code: "EQ-1",
      title: "ZX-9",
      status: { labelKey: "console.modules.asset.statuses.rented", tone: "ok" },
      cells: { model: "ZX-9", maker: undefined },
      detail: { vin: "VIN-1" },
      linkChips: [
        {
          key: "costLedger",
          labelKey: "console.modules.asset.links.costLedger",
          kind: "cost_ledger",
          id: "eq-1",
          code: "3",
          policyAction: "equipment_cost_ledger_read",
        },
      ],
    };
    const card = rowCardDescriptor(getObjectType("equipment"), row);
    expect(card.code).toBe("EQ-1");
    expect(card.title).toBe("ZX-9");
    expect(card.properties.find((prop) => prop.key === "model")?.value).toBe("ZX-9");
    expect(card.properties.find((prop) => prop.key === "vin")?.value).toBe("VIN-1");
    expect(card.properties.find((prop) => prop.key === "status")?.value).toBe("임대");
    expect(card.properties.some((prop) => prop.key === "maker")).toBe(false);
    expect(card.relations[0]?.code).toBe("3");
    expect(card.relations[0]?.linkType).toBe("원가 원장");
  });
});
