import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PREFIXES, plan, prefixOf } from "./prune-plan.mjs";

const RUSTC_A = "nativelink-cas-linux-x64-rustc-1.100.0-nightly-a36d05efa-cc-Ubuntu-clang-version-18.1.3-1ubuntu1-";
const RUSTC_B = "nativelink-cas-linux-x64-rustc-1.97.1-8bab26f4f-cc-Ubuntu-clang-version-18.1.3-1ubuntu1-";
const CLANG_B = "nativelink-cas-linux-x64-rustc-1.100.0-nightly-a36d05efa-cc-Ubuntu-clang-version-17.0.6-1ubuntu1-";
const BOTH_B = "nativelink-cas-linux-x64-rustc-1.97.1-8bab26f4f-cc-Ubuntu-clang-version-17.0.6-1ubuntu1-";

let next = 0;
/** `at` is both created and last-accessed unless `used` says otherwise. */
const cache = (prefix, at, { used = at, size = 1 } = {}) => ({
  id: ++next,
  key: `${prefix}${1000 + next}`,
  created_at: at,
  last_accessed_at: used,
  size_in_bytes: size,
});
const payload = (...actions_caches) => ({ actions_caches });
const doomedKeys = (input, opts) => plan(input, opts).map((c) => c.key);
const keptKeys = (input, opts) => {
  const doomed = new Set(plan(input, opts).map((c) => c.id));
  return input.actions_caches.filter((c) => !doomed.has(c.id)).map((c) => c.key);
};

describe("prefixOf", () => {
  it("strips the trailing run id", () => {
    assert.equal(prefixOf(`${RUSTC_A}12345`), RUSTC_A);
  });

  it("treats a key with no trailing run id as its own prefix", () => {
    assert.equal(prefixOf("nativelink-cas-odd"), "nativelink-cas-odd");
  });

  it("relies on the prefix ending in a non-digit, and merges when it does not", () => {
    // Load-bearing, and asserted here because the invariant lives in a printf
    // inside .github/actions/cas-inrunner/action.yml where nothing checks it.
    //
    // A trailing separator is what saves this: `...-clang-18-` + `1001` strips
    // only the run id, because `-` breaks the digit run.
    assert.equal(prefixOf("nativelink-cas-cc-clang-18-1001"), "nativelink-cas-cc-clang-18-");
    assert.notEqual(prefixOf("nativelink-cas-cc-clang-18-1001"), prefixOf("nativelink-cas-cc-clang-17-1002"));

    // Drop that separator and the digits run together, so two clangs collapse
    // into one prefix and the loser's only seed is evicted. Both current
    // formats end in `-`; this records what breaks if one ever does not.
    assert.equal(prefixOf("nativelink-cas-cc-clang-181001"), "nativelink-cas-cc-clang-");
    assert.equal(prefixOf("nativelink-cas-cc-clang-171002"), "nativelink-cas-cc-clang-");
  });
});

describe("pruning is per-prefix", () => {
  it("does not let one busy prefix evict another prefix's only seed", () => {
    // THE BUG. Prefix-blind "keep the two newest" keeps both of A's and deletes
    // B's only one, so every job on compiler B builds cold.
    const input = payload(
      cache(RUSTC_A, "2026-09-10T10:00:00Z"),
      cache(RUSTC_A, "2026-09-10T09:00:00Z"),
      cache(RUSTC_B, "2026-09-10T08:00:00Z"),
    );
    const kept = keptKeys(input);
    assert.equal(kept.filter((k) => k.startsWith(RUSTC_B)).length, 1, "B lost its only seed");
    assert.equal(kept.filter((k) => k.startsWith(RUSTC_A)).length, 1, "A should keep exactly one generation");
  });

  it("keeps the newest CREATED generation, which is the one restore-keys returns", () => {
    // Ordering within a prefix must be real: with no ordering at all, the
    // survivor is whichever happened to be first in the payload.
    const input = payload(
      cache(RUSTC_A, "2026-09-08T10:00:00Z"),
      cache(RUSTC_A, "2026-09-10T10:00:00Z"),
      cache(RUSTC_A, "2026-09-09T10:00:00Z"),
    );
    const kept = keptKeys(input);
    assert.equal(kept.length, 1);
    assert.equal(kept[0], input.actions_caches[1].key, "kept the wrong generation");
  });

  it("survives all four rustc x cc combinations being live at once", () => {
    // The arity #1088 creates: rustc is two-valued during a toolchain roll and
    // cc is two-valued during a runner-image rollout. Retiring any of the four
    // evicts a live seed -- this file's own bug, one arity up.
    const input = payload(
      cache(RUSTC_A, "2026-09-10T10:00:00Z"),
      cache(RUSTC_B, "2026-09-10T09:00:00Z"),
      cache(CLANG_B, "2026-09-10T08:00:00Z"),
      cache(BOTH_B, "2026-09-10T07:00:00Z"),
    );
    assert.deepEqual(plan(input), [], "no live combination may be retired");
    assert.ok(PREFIXES >= 4, "PREFIXES must cover rustc x cc");
  });

  it("retires the least recently USED prefix once more than PREFIXES are live", () => {
    const OLD = "nativelink-cas-linux-x64-rustc-1.96.0-deadbeef-cc-x-";
    const input = payload(
      cache(RUSTC_A, "2026-09-10T10:00:00Z"),
      cache(RUSTC_B, "2026-09-10T09:00:00Z"),
      cache(CLANG_B, "2026-09-10T08:00:00Z"),
      cache(BOTH_B, "2026-09-10T07:00:00Z"),
      cache(OLD, "2026-06-01T10:00:00Z"),
    );
    assert.deepEqual(doomedKeys(input), [input.actions_caches[4].key]);
  });

  it("ranks by last use, not by creation: a rarely-seeded but hot prefix survives", () => {
    // The API defaults to sorting by last_accessed_at, and retirement means
    // "nothing has needed this compiler lately". A prefix dev seeds rarely but
    // PRs restore from hourly has an OLD created_at and a FRESH last_accessed_at;
    // ranking on creation retires it while a seeded-once-never-used prefix wins.
    const HOT = "nativelink-cas-linux-x64-rustc-hot-cc-x-";
    const COLD = "nativelink-cas-linux-x64-rustc-cold-cc-x-";
    const input = payload(
      cache(RUSTC_A, "2026-09-10T10:00:00Z"),
      cache(RUSTC_B, "2026-09-10T09:00:00Z"),
      cache(CLANG_B, "2026-09-10T08:00:00Z"),
      cache(HOT, "2026-01-01T00:00:00Z", { used: "2026-09-10T11:00:00Z" }),
      cache(COLD, "2026-09-09T00:00:00Z", { used: "2026-02-01T00:00:00Z" }),
    );
    const kept = keptKeys(input);
    assert.ok(kept.some((k) => k.startsWith(HOT)), "the hot prefix was retired despite recent use");
    assert.ok(!kept.some((k) => k.startsWith(COLD)), "the cold prefix should have been retired");
  });

  it("ranks a prefix by its own activity, not by how many caches it holds", () => {
    // A prefix with many old generations must not outrank four live ones.
    const FAT = "nativelink-cas-linux-x64-rustc-fat-cc-x-";
    const input = payload(
      cache(FAT, "2026-01-01T00:00:00Z"),
      cache(FAT, "2026-01-02T00:00:00Z"),
      cache(FAT, "2026-01-03T00:00:00Z"),
      cache(RUSTC_A, "2026-09-10T10:00:00Z"),
      cache(RUSTC_B, "2026-09-10T09:00:00Z"),
      cache(CLANG_B, "2026-09-10T08:00:00Z"),
      cache(BOTH_B, "2026-09-10T07:00:00Z"),
    );
    const kept = keptKeys(input);
    assert.equal(kept.length, 4, "the four live prefixes should survive, one generation each");
    assert.ok(!kept.some((k) => k.startsWith(FAT)), "the fat stale prefix should be retired entirely");
  });
});

describe("it does not touch what it does not own", () => {
  it("never deletes a cache outside the nativelink-cas- selector", () => {
    // The protected prefixes get TWO caches each, deliberately. With one apiece
    // the retention arithmetic deletes nothing regardless of the selector, and
    // this assertion passes with the selector removed entirely -- which is what
    // it did before, leaving the invariant it names completely unguarded in a
    // job that holds `actions: write`.
    const input = payload(
      { id: 900, key: "v0-rust-abc-1", created_at: "2020-01-01T00:00:00Z", last_accessed_at: "2020-01-01T00:00:00Z", size_in_bytes: 1 },
      { id: 901, key: "v0-rust-abc-2", created_at: "2020-01-02T00:00:00Z", last_accessed_at: "2020-01-02T00:00:00Z", size_in_bytes: 1 },
      { id: 902, key: "node-cache-abc-1", created_at: "2020-01-01T00:00:00Z", last_accessed_at: "2020-01-01T00:00:00Z", size_in_bytes: 1 },
      { id: 903, key: "node-cache-abc-2", created_at: "2020-01-02T00:00:00Z", last_accessed_at: "2020-01-02T00:00:00Z", size_in_bytes: 1 },
      cache(RUSTC_A, "2026-09-10T10:00:00Z"),
      cache(RUSTC_A, "2026-09-10T09:00:00Z"),
    );
    const doomed = doomedKeys(input);
    assert.ok(doomed.every((k) => k.startsWith("nativelink-cas-")), `planned a protected cache: ${doomed}`);
    assert.equal(doomed.length, 1, "should still prune its own redundant generation");
  });

  it("plans nothing for an empty, malformed or wrongly-typed payload", () => {
    // A prune that crashes never runs; one that deletes on a guess is worse.
    // `actions_caches` as an object or string used to throw from inside plan().
    assert.deepEqual(plan({}), []);
    assert.deepEqual(plan({ actions_caches: [] }), []);
    assert.deepEqual(plan({ actions_caches: [{ nokey: true }] }), []);
    assert.deepEqual(plan({ actions_caches: {} }), []);
    assert.deepEqual(plan({ actions_caches: "nope" }), []);
    assert.deepEqual(plan(null), []);
  });

  it("does not delete a cache merely because its timestamps are null", () => {
    // A partially-null row sorted last and got planned for deletion. One seed
    // per prefix must survive even when the API omits its dates.
    const input = payload({ id: 950, key: `${RUSTC_A}1`, created_at: null, last_accessed_at: null, size_in_bytes: 1 });
    assert.deepEqual(plan(input), []);
  });
});
