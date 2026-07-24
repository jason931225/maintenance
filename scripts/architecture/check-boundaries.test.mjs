import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { evaluateArchitecture } from "./check-boundaries.mjs";

const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "architecture-boundary-")); roots.push(root);
  for (const [path, content] of Object.entries(files)) { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), content); }
  return root;
}
function cargo(deps) { return `[package]\nname = "fixture"\n[dependencies]\n${deps}\n`; }

describe("clean architecture boundary gate", () => {
  it("rejects an application dependency on its Postgres adapter", () => {
    const root = fixture({ "backend/crates/orders/application/Cargo.toml": cargo("mnt-orders-adapter-postgres = { workspace = true }") });
    assert.deepEqual(evaluateArchitecture(root).failures.map((item) => item.rule), ["backend-dependency-direction"]);
  });
  it("rejects framework imports in domain and application layers", () => {
    const root = fixture({ "backend/crates/orders/domain/src/lib.rs": "use sqlx::Pool;", "backend/crates/orders/application/Cargo.toml": cargo("axum = { workspace = true }") });
    assert.deepEqual(evaluateArchitecture(root).failures.map((item) => item.rule), ["backend-inner-framework", "backend-inner-framework"]);
  });
  it("rejects generated client types outside a transport adapter", () => {
    const root = fixture({ "web/src/features/orders/ui/OrderPage.tsx": 'import type { components } from "@maintenance/api-client-ts";' });
    assert.equal(evaluateArchitecture(root).failures[0].rule, "generated-client-boundary");
  });
  it("rejects lifecycle policy-shaped REST handlers and shared dumping grounds", () => {
    const root = fixture({
      "backend/crates/orders/rest/src/lib.rs": "pub async fn approve_order() {}",
      "web/src/shared/order.ts": "export {};",
    });
    assert.deepEqual(evaluateArchitecture(root).failures.map((item) => item.rule), ["no-global-shared-dumping-ground", "rest-lifecycle-policy"]);
  });
  it("rejects upward feature imports and cross-module private imports", () => {
    const root = fixture({
      "web/src/features/orders/domain/order.ts": 'import "../ui/Button"; import "../../inventory/domain/private";',
      "web/src/features/orders/ui/Button.tsx": "export {};",
      "web/src/features/inventory/domain/private.ts": "export {};",
    });
    assert.deepEqual(evaluateArchitecture(root).failures.map((item) => item.rule), ["frontend-dependency-direction", "module-public-surface"]);
  });
  it("checks only selected changed paths and honors explicit debt ids", () => {
    const root = fixture({
      "web/src/features/orders/ui/legacy.ts": 'import type { components } from "@maintenance/api-client-ts";',
      "web/src/features/orders/ui/new.ts": 'import type { components } from "@maintenance/api-client-ts";',
    });
    const first = evaluateArchitecture(root, ["web/src/features/orders/ui/legacy.ts"]);
    assert.equal(evaluateArchitecture(root, ["web/src/features/orders/ui/new.ts"], first.violations).failures.length, 1);
    assert.equal(evaluateArchitecture(root, ["web/src/features/orders/ui/legacy.ts"], first.violations).failures.length, 0);
  });
});
