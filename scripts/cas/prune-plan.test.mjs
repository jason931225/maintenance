import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { plan, prefixOf } from "./prune-plan.mjs";

const RUSTC_A = "nativelink-cas-linux-x64-rustc-1.100.0-nightly-a36d05efa-cc-Ubuntu-clang-version-18.1.3-1ubuntu1-";
const RUSTC_B = "nativelink-cas-linux-x64-rustc-1.97.1-8bab26f4f-cc-Ubuntu-clang-version-18.1.3-1ubuntu1-";
const CLANG_B = "nativelink-cas-linux-x64-rustc-1.100.0-nightly-a36d05efa-cc-Ubuntu-clang-version-17.0.6-1ubuntu1-";

let next = 0;
const cache = (prefix, created_at, size = 1) => ({
  id: ++next,
  key: `${prefix}${1000 + next}`,
  created_at,
  size_in_bytes: size,
});
const payload = (...actions_caches) => ({ actions_caches });
const keptKeys = (input, opts) => {
  const doomed = new Set(plan(input, opts).map((c) => c.id));
  return input.actions_caches.filter((c) => !doomed.has(c.id)).map((c) => c.key);
};

describe("prefixOf", () => {
  it("strips the trailing run id", () => {
    assert.equal(prefixOf(`${RUSTC_A}12345`), RUSTC_A);
  });

  it("treats a key with no trailing run id as its own prefix", () => {
    // Not an error: it is still a cache under the selector, and dropping it
    // from the plan would exempt it from pruning forever.
    assert.equal(prefixOf("nativelink-cas-odd"), "nativelink-cas-odd");
  });

  it("does not merge two compilers that differ only late in the key", () => {
    // The C compiler is the LAST component, so a naive prefix rule that cut at
    // a fixed offset would collapse these into one and evict a live seed.
    assert.notEqual(prefixOf(`${RUSTC_A}1`), prefixOf(`${CLANG_B}1`));
  });
});

describe("pruning is per-prefix", () => {
  it("does not let one busy prefix evict another prefix's only seed", () => {
    // THE BUG. Prefix-blind "keep the two newest" would keep both of A's
    // caches and delete B's only one, so every job on compiler B builds cold.
    const input = payload(
      cache(RUSTC_A, "2026-09-10T10:00:00Z"),
      cache(RUSTC_A, "2026-09-10T09:00:00Z"),
      cache(RUSTC_B, "2026-09-10T08:00:00Z"),
    );
    const kept = keptKeys(input);
    assert.equal(kept.filter((k) => k.startsWith(RUSTC_B)).length, 1, "B lost its only seed");
    assert.equal(kept.filter((k) => k.startsWith(RUSTC_A)).length, 1, "A should keep exactly one generation");
  });

  it("keeps one generation of each live prefix and deletes older ones", () => {
    const input = payload(
      cache(RUSTC_A, "2026-09-10T10:00:00Z"),
      cache(RUSTC_A, "2026-09-09T10:00:00Z"),
      cache(RUSTC_A, "2026-09-08T10:00:00Z"),
    );
    assert.equal(plan(input).length, 2);
    assert.equal(keptKeys(input).length, 1);
  });

  it("distinguishes prefixes that differ only in the C compiler", () => {
    // Directly the #1088 case: same rustc, different clang. An object built by
    // one cannot be linked by the other, so these must not share retention.
    const input = payload(
      cache(RUSTC_A, "2026-09-10T10:00:00Z"),
      cache(CLANG_B, "2026-09-10T09:00:00Z"),
    );
    assert.deepEqual(plan(input), [], "neither should be deleted");
  });

  it("retires the oldest prefix once more than PREFIXES are live", () => {
    // Otherwise every retired toolchain leaves a seed behind forever, against
    // the repository's 8 GiB budget.
    const D = "nativelink-cas-linux-x64-rustc-1.96.0-deadbeef-cc-x-";
    const input = payload(
      cache(RUSTC_A, "2026-09-10T10:00:00Z"),
      cache(RUSTC_B, "2026-09-09T10:00:00Z"),
      cache(CLANG_B, "2026-09-08T10:00:00Z"),
      cache(D, "2026-06-01T10:00:00Z"),
    );
    const kept = keptKeys(input);
    assert.equal(kept.length, 3);
    assert.equal(kept.some((k) => k.startsWith(D)), false, "the retired prefix should be gone");
  });

  it("ranks a prefix by its newest cache, not by how many it holds", () => {
    const D = "nativelink-cas-linux-x64-rustc-old-cc-x-";
    const input = payload(
      cache(D, "2026-01-01T00:00:00Z"),
      cache(D, "2026-01-02T00:00:00Z"),
      cache(D, "2026-01-03T00:00:00Z"),
      cache(RUSTC_A, "2026-09-10T10:00:00Z"),
    );
    assert.equal(keptKeys(input).some((k) => k.startsWith(RUSTC_A)), true, "the newest prefix must survive");
  });
});

describe("it does not touch what it does not own", () => {
  it("ignores caches outside the nativelink-cas- selector", () => {
    // cache-hygiene protects v0-rust- and node-cache-; deleting one here would
    // be this job reaching outside its own store.
    const input = payload(
      { id: 900, key: "v0-rust-abc", created_at: "2020-01-01T00:00:00Z", size_in_bytes: 1 },
      { id: 901, key: "node-cache-abc", created_at: "2020-01-01T00:00:00Z", size_in_bytes: 1 },
      cache(RUSTC_A, "2026-09-10T10:00:00Z"),
    );
    assert.deepEqual(plan(input), []);
  });

  it("plans nothing for an empty or malformed payload rather than throwing", () => {
    // A prune that crashes is a prune that never runs; one that deletes on a
    // guess is worse. Both shapes must simply plan nothing.
    assert.deepEqual(plan({}), []);
    assert.deepEqual(plan({ actions_caches: [] }), []);
    assert.deepEqual(plan({ actions_caches: [{ nokey: true }] }), []);
  });
});
