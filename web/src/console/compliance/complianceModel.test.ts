import { describe, expect, it } from "vitest";

import { catalogStats, controlEvidenceLedger, filterRows, kindChip, nextStates, riskChipTone, toRows } from "./complianceModel";
import type { ComplianceCatalogItem, ComplianceFramework, ComplianceObligation, RegulationImpact } from "./types";

const base = { metadata: {}, createdBy: "creator", updatedBy: "updater", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z" };
const obligation = (overrides: Partial<ComplianceObligation> = {}): ComplianceObligation => ({
  ...base, kind: "obligation", id: "cp-1", code: "CP-0001", title: "근로시간 준수", description: "근로시간을 검토합니다.",
  obligationType: "LEGAL", scopeKind: "ORG", scope: { scope_type: "ORG", scope_ref: null, branch_id: null, site_id: null },
  severity: "HIGH", status: "ACTIVE", ...overrides,
});
const regulation = (overrides: Partial<RegulationImpact> = {}): RegulationImpact => ({
  ...base, kind: "regulation", id: "rg-1", code: "RG-0001", title: "근로기준법", jurisdiction: "대한민국", citation: "근로기준법 제50조",
  impactArea: "인사", impactSummary: "근로시간 규정", riskLevel: "HIGH", status: "ACTIVE", ...overrides,
});
const framework = (overrides: Partial<ComplianceFramework> = {}): ComplianceFramework => ({
  ...base, kind: "framework", id: "fw-1", code: "FW-0001", title: "ISMS", versionLabel: "2025", frameworkKind: "SECURITY_STANDARD",
  status: "ACTIVE", controls: [{ id: "ctl-1", frameworkId: "fw-1", controlKey: "ISMS-1", title: "접근 통제", objective: "접근 검토",
    controlType: "PREVENTIVE", status: "ACTIVE", evidenceRequirements: {}, createdBy: "creator", updatedBy: "updater", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z",
    evidenceBindings: [{ id: "ev-1", controlId: "ctl-1", evidenceTargetType: "DOCUMENT", evidenceTargetId: "doc-1", status: "ACCEPTED", confidence: "HIGH", metadata: {}, createdBy: "creator", updatedBy: "updater", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z" }] }], ...overrides,
});
const catalog = (): ComplianceCatalogItem[] => [obligation(), obligation({ id: "cp-2", code: "CP-0002", status: "WAIVED", severity: "CRITICAL" }), regulation({ id: "rg-2", code: "RG-0002", riskLevel: "CRITICAL" }), framework()];

describe("complianceModel", () => {
  describe("kindChip", () => {
    it("assigns the 구분 badge code per kind, distinct per catalog object", () => {
      expect(kindChip("obligation", "cp-1").code).toBe("CP");
      expect(kindChip("regulation", "rg-1").code).toBe("RG");
      expect(kindChip("framework", "fw-1").code).toBe("FW");
    });
  });

  describe("nextStates — mirrors backend validate_*_status_transition", () => {
    it("obligation: DRAFT can go active or archived, never waived", () => {
      const labels = nextStates("obligation", "DRAFT").map((s) => s.labelKey);
      expect(labels).toEqual(["console.modules.compliance.statuses.active", "console.modules.compliance.statuses.archived"]);
    });

    it("obligation: ACTIVE can waive, supersede, or archive", () => {
      const labels = nextStates("obligation", "ACTIVE").map((s) => s.labelKey);
      expect(labels).toEqual([
        "console.modules.compliance.statuses.waived",
        "console.modules.compliance.statuses.superseded",
        "console.modules.compliance.statuses.archived",
      ]);
    });

    it("obligation: WAIVED can resume to active (not a dead end)", () => {
      const labels = nextStates("obligation", "WAIVED").map((s) => s.labelKey);
      expect(labels).toContain("console.modules.compliance.statuses.active");
    });

    it("regulation: SUPERSEDED can only archive (never resumes to active)", () => {
      const labels = nextStates("regulation", "SUPERSEDED").map((s) => s.labelKey);
      expect(labels).toEqual(["console.modules.compliance.statuses.archived"]);
    });

    it("framework: ACTIVE can retire or archive, never go back to draft", () => {
      const labels = nextStates("framework", "ACTIVE").map((s) => s.labelKey);
      expect(labels).toEqual(["console.modules.compliance.statuses.retired", "console.modules.compliance.statuses.archived"]);
    });

    it("ARCHIVED is terminal for every kind", () => {
      expect(nextStates("obligation", "ARCHIVED")).toEqual([]);
      expect(nextStates("regulation", "ARCHIVED")).toEqual([]);
      expect(nextStates("framework", "ARCHIVED")).toEqual([]);
    });
  });

  describe("riskChipTone", () => {
    it("escalates tone with risk severity, CRITICAL reads as the strongest tone", () => {
      expect(riskChipTone("INFO")).toBe("neutral");
      expect(riskChipTone("HIGH")).toBe("danger");
      expect(riskChipTone("CRITICAL")).toBe("purple");
    });
  });

  describe("toRows", () => {
    it("carries the REAL per-kind status onto the row, not a generic placeholder", () => {
      const [waivedObligation] = toRows(catalog()).filter((row) => row.code === "CP-0002");
      expect(waivedObligation.status?.labelKey).toBe("console.modules.compliance.statuses.waived");
      expect(waivedObligation.status?.tone).toBe("warn");
    });

    it("populates RG- impact fields in the detail payload", () => {
      const [regRow] = toRows([regulation()]);
      expect(regRow.detail?.jurisdiction).toBe("대한민국");
      expect(regRow.detail?.citation).toBe("근로기준법 제50조");
      expect(regRow.detail?.impactArea).toBe("인사");
    });

    it("attaches a control-evidence ledger only to framework rows", () => {
      const rows = toRows(catalog());
      const obligationRow = rows.find((row) => row.code === "CP-0001");
      const frameworkRow = rows.find((row) => row.code === "FW-0001");
      expect(obligationRow?.detail?.controlEvidenceMatrix).toBeUndefined();
      expect(frameworkRow?.detail?.controlEvidenceMatrix).toMatchObject({ total: "1/1" });
    });

    it("every row carries an audit-trail link chip", () => {
      for (const row of toRows(catalog())) {
        expect(row.linkChips?.some((chip) => chip.key === "auditTrail")).toBe(true);
      }
    });
  });

  describe("controlEvidenceLedger", () => {
    it("summarizes accepted-evidence coverage as accepted/total", () => {
      const isms = framework();
      const ledger = controlEvidenceLedger(isms);
      expect(ledger.total).toBe("1/1");
      expect(ledger.entries).toHaveLength(1);
      expect(ledger.entries[0]).toMatchObject({ tone: "ok", amount: 1 });
    });
  });

  describe("filterRows", () => {
    it("matches by title substring case-insensitively", () => {
      const rows = toRows(catalog());
      const matched = filterRows(rows, "근로시간");
      expect(matched.map((r) => r.code)).toEqual(["CP-0001", "CP-0002"]);
    });

    it("returns all rows for an empty query", () => {
      const rows = toRows(catalog());
      expect(filterRows(rows, "  ")).toHaveLength(rows.length);
    });

    it("returns nothing for a query matching no row", () => {
      const rows = toRows(catalog());
      expect(filterRows(rows, "nonexistent-zzz")).toEqual([]);
    });
  });

  describe("catalogStats", () => {
    it("flags WAIVED obligations and CRITICAL risk items as needing attention", () => {
      const stats = catalogStats(catalog());
      expect(stats.attention).toBe(2);
      expect(stats.frameworks).toBe(1);
    });

    it("counts only rows in the real ACTIVE state", () => {
      const stats = catalogStats(catalog());
      expect(stats.active).toBe(3);
    });
  });
});
