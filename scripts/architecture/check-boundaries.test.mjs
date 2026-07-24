import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { evaluateArchitecture, evaluateLedgerGrowth, validateCiBaseline, validateLedger } from "./check-boundaries.mjs";

const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(files) { const root = mkdtempSync(join(tmpdir(), "architecture-boundary-")); roots.push(root); for (const [path, content] of Object.entries(files)) { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), content); } return root; }
function cargo(deps) { return `[package]\nname = "fixture"\n[dependencies]\n${deps}\n`; }

describe("clean architecture boundary gate", () => {
  it("rejects an application dependency on its Postgres adapter, including package aliases", () => {
    const root = fixture({
      "backend/Cargo.toml": "[workspace.dependencies]\nstorage = { package = \"mnt-orders-adapter-postgres\", version = \"*\" }\n",
      "backend/crates/orders/application/Cargo.toml": "[package]\nname=\"fixture\"\n[target.'cfg(unix)'.dependencies]\nstorage = { workspace = true }\n",
    });
    assert.equal(evaluateArchitecture(root).failures[0].rule, "backend-dependency-direction");
  });
  it("rejects framework imports in inner layers, including Cargo aliases", () => {
    const root = fixture({ "backend/crates/orders/domain/src/lib.rs": "use database::Pool;", "backend/crates/orders/domain/Cargo.toml": cargo('database = { package = "sqlx", version = "*" }') });
    assert.deepEqual(evaluateArchitecture(root).failures.map((item) => item.rule), ["backend-inner-framework", "backend-inner-framework"]);
  });
  it("rejects direct persistence and lifecycle mutation anywhere in REST", () => {
    const root = fixture({ "backend/crates/orders/rest/src/helpers.rs": "use mnt_orders_domain::OrderStatus; async fn helper() { sqlx::query(\"UPDATE orders\").execute(&db).await; }" });
    assert.equal(evaluateArchitecture(root).failures[0].rule, "rest-application-boundary");
  });
  it("rejects generated client types outside adapters and generated API re-exports consumed by UI", () => {
    const root = fixture({
      "web/src/api/orderTypes.ts": 'import type { components as Wire } from "@maintenance/api-client-ts"; export type Order = Wire["schemas"]["Order"];',
      "web/src/features/orders/ui/OrderPage.tsx": 'import type { Order } from "../../../api/orderTypes"; import type { components } from "@maintenance/api-client-ts";',
    });
    assert.deepEqual(evaluateArchitecture(root).failures.map((item) => item.rule), ["generated-client-boundary", "generated-client-reexport-boundary"]);
  });
  it("requires public.ts/index.ts for cross-feature imports even when the target is flat", () => {
    const root = fixture({ "web/src/pages/OrdersPage.tsx": 'import "../features/inventory/private";', "web/src/features/inventory/private.ts": "export {};" });
    assert.equal(evaluateArchitecture(root).failures[0].rule, "module-public-surface");
  });
  it("rejects upward imports and global shared dumping grounds", () => {
    const root = fixture({ "web/src/features/orders/domain/order.ts": 'import "../ui/Button";', "web/src/features/orders/ui/Button.tsx": "export {};", "web/src/shared/order.ts": "export {};" });
    assert.deepEqual(evaluateArchitecture(root).failures.map((item) => item.rule), ["frontend-dependency-direction", "no-global-shared-dumping-ground"]);
  });
  it("checks only selected paths and honors known debt", () => {
    const root = fixture({ "web/src/features/orders/ui/legacy.ts": 'import type { components } from "@maintenance/api-client-ts";', "web/src/features/orders/ui/new.ts": 'import type { components } from "@maintenance/api-client-ts";' });
    const first = evaluateArchitecture(root, ["web/src/features/orders/ui/legacy.ts"]);
    assert.equal(evaluateArchitecture(root, ["web/src/features/orders/ui/new.ts"], first.violations).failures.length, 1);
    assert.equal(evaluateArchitecture(root, ["web/src/features/orders/ui/legacy.ts"], first.violations).failures.length, 0);
  });
  it("rejects symbolic, untrusted CI baseline overrides and invalid ledger entries", () => {
    const contract = { immutableCommit: "49301e1e84dcee74c49f1582a67e353d995d8c08" };
    assert.equal(validateCiBaseline(".", "HEAD", contract)[0].detail, "baseline-must-be-full-immutable-sha");
    assert.equal(validateCiBaseline(".", "0000000000000000000000000000000000000000", contract)[0].detail, "baseline-does-not-match-protected-contract");
    const invalid = validateLedger({ exceptions: [{ id: "same", owner: "", target: "", expiresOn: "2000-01-01" }, { id: "same", owner: "a", target: "b", expiresOn: "2027-01-01" }] }, "2026-07-23");
    assert.ok(invalid.some((item) => item.detail.startsWith("duplicate-or-missing-id")));
    assert.ok(invalid.some((item) => item.detail.startsWith("missing-owner")));
    assert.ok(invalid.some((item) => item.detail.startsWith("stale-or-missing-expiry")));
  });
  it("allows ledger removals but rejects additions and retained-entry modifications", () => {
    const trusted = { exceptions: [{ id: "one", rule: "x", path: "a" }, { id: "two", rule: "x", path: "b" }] };
    assert.deepEqual(evaluateLedgerGrowth({ exceptions: [{ id: "one", rule: "x", path: "a" }] }, trusted), []);
    assert.equal(evaluateLedgerGrowth({ exceptions: [{ id: "one", rule: "changed", path: "a" }] }, trusted)[0].detail, "modified:one");
    assert.equal(evaluateLedgerGrowth({ exceptions: [{ id: "three", rule: "x", path: "c" }] }, trusted)[0].detail, "unapproved:three");
  });
});
