import { afterEach, describe, expect, it, vi } from "vitest";

// moduleScreens aggregates every hand-authored surface, incl. the compliance
// lane's module whose ko manifest merges only at serial-wire time; stub it so
// this grammar test stays hermetic and independent of unrelated lane churn.
vi.mock("../compliance", () => ({
  complianceModuleScreen: { id: "compliance", screen: "compliance" },
}));

import type { ConsoleApiClient } from "../../api/client";
import { buildApprComposerCandidates } from "../appr/composeModel";
import {
  buildComposerCandidates,
  extractObjectCodes,
  renderMessageParts,
} from "../messenger/messengerModel";
import { getModuleScreen } from "../modules/moduleScreens";
import { getObjectType } from "../modules/typeRegistry";
import { parseObjectRefText } from "../window/objDrag";
import { resetCodePrefixes } from "./codeGrammar";
import {
  loadObjectTypeRegistry,
  primeObjectTypeRegistry,
  resetObjectTypeRegistry,
  type RegistryObjectType,
} from "./typeRegistrySource";

// The no-code acceptance test: a type registered via the Ontology Manager
// (mocked GET /api/v1/object-types payload) must make its codes drag/parse
// across ALL parsers and render a module surface with ZERO frontend code edit.
// WD- is deliberately NOT one of the seeded fallback prefixes, so any success
// below is proof the grammar became dynamic, not that WD- was hardcoded.

const WIDGET: RegistryObjectType = {
  kind: "widget",
  codePrefix: "WD-",
  description: "위젯",
  status: "active",
  activeCount: 3,
};

const NO_SOURCES = { members: [], channels: [] };

afterEach(() => {
  resetObjectTypeRegistry();
  resetCodePrefixes();
  vi.restoreAllMocks();
});

describe("dynamic code grammar — no-code new type", () => {
  it("does NOT recognise a new prefix before the registry is primed", () => {
    // fail-closed / dynamic proof: unknown prefix is inert...
    expect(parseObjectRefText("WD-42")).toBeNull();
    expect(getObjectType("widget")).toBeUndefined();
    expect(getModuleScreen("widget").id).toBe("finance"); // default, not derived
    // ...while the seeded fallback keeps working offline.
    expect(parseObjectRefText("WO-42")).toEqual({ code: "WO-42", title: "WO-42" });
  });

  it("makes the new type's codes drag/parse across every consumer once primed", () => {
    primeObjectTypeRegistry([WIDGET]);

    // objDrag: bare code + bracketed drag token round-trip.
    expect(parseObjectRefText("WD-42")).toEqual({ code: "WD-42", title: "WD-42" });
    expect(parseObjectRefText("[WD-42 신규 위젯]")).toEqual({
      code: "WD-42",
      title: "신규 위젯",
    });

    // messenger: #code marker rendering, extraction, and composer autocomplete.
    const parts = renderMessageParts("점검 WD-42 확인");
    expect(parts).toContainEqual({ kind: "object", text: "WD-42", code: "WD-42" });
    expect(extractObjectCodes([{ body: "WD-42 처리" } as never])).toContain("WD-42");
    const msgrCandidates = buildComposerCandidates("WD-", 3, {
      ...NO_SOURCES,
      objectCodes: ["WD-42"],
    });
    expect(msgrCandidates).toContainEqual({
      kind: "object",
      label: "WD-42",
      insertText: "WD-42",
    });

    // approval compose: target autocomplete on the new prefix.
    const apprCandidates = buildApprComposerCandidates("WD-", 3, {
      ...NO_SOURCES,
      objectCodes: ["WD-42"],
    });
    expect(apprCandidates).toContainEqual({
      kind: "object",
      label: "WD-42",
      insertText: "WD-42",
    });

    // union floor: the seeded prefixes still parse after priming.
    expect(parseObjectRefText("AP-2026-00012")).toEqual({
      code: "AP-2026-00012",
      title: "AP-2026-00012",
    });
  });

  it("derives a card def + module surface for the new type with no config edit", () => {
    primeObjectTypeRegistry([WIDGET]);

    const type = getObjectType("widget");
    expect(type).toMatchObject({
      key: "widget",
      code: "OT-WIDGET",
      codePrefix: "WD-",
      nameKey: "위젯",
    });
    expect(type?.propSchema.map((prop) => prop.id)).toEqual(["code", "title"]);

    const screen = getModuleScreen("widget");
    expect(screen.id).toBe("widget");
    expect(screen.objectKind).toBe("widget");
    expect(screen.codePrefix).toBe("WD-");
    // honest empty state — no fabricated rows until the instances API serves it.
    expect(screen.emptyMode).toBe("blocked-until-backend");
    expect(screen.rows).toEqual([]);
    expect(screen.list.columns.map((column) => column.key)).toEqual(["code", "title"]);
  });

  it("grammar recognition is NOT authorization — PBAC still gates rendering", () => {
    primeObjectTypeRegistry([WIDGET]);
    // recognised as a code, but an empty authorized set degrades it to text.
    const parts = renderMessageParts("WD-42", { authorizedObjectCodes: new Set() });
    expect(parts).toEqual([{ kind: "text", text: "WD-42" }]);
  });

  it("primes from the real typed client fetch and fails closed on error", async () => {
    const okApi = {
      GET: vi.fn().mockResolvedValue({
        data: [
          { kind: "widget", code_prefix: "WD-", description: "위젯", status: "active", active_count: 3 },
        ],
      }),
    } as unknown as ConsoleApiClient;
    const loaded = await loadObjectTypeRegistry(okApi);
    expect(loaded.map((type) => type.kind)).toContain("widget");
    expect(parseObjectRefText("WD-42")).toEqual({ code: "WD-42", title: "WD-42" });

    resetObjectTypeRegistry();
    resetCodePrefixes();

    // network/parse failure: resolves (no throw), grammar stays at the fallback.
    const badApi = {
      GET: vi.fn().mockRejectedValue(new Error("network down")),
    } as unknown as ConsoleApiClient;
    await expect(loadObjectTypeRegistry(badApi)).resolves.toEqual([]);
    expect(parseObjectRefText("WD-42")).toBeNull(); // unknown prefix inert
    expect(parseObjectRefText("WO-42")).toEqual({ code: "WO-42", title: "WO-42" }); // fallback intact
  });
});
