#!/usr/bin/env node
// Which CAS caches to delete, decided per PREFIX rather than globally (#1089).
//
// The prefix names the compilers whose artifacts a store holds -- since #1086 it
// carries `rustc --version`, and since #1088 the C compiler too. It is therefore
// MULTI-VALUED: a toolchain roll, a long-running roll PR, or two runner images
// with different clang all put several live prefixes in the repository at once.
//
// The previous policy sorted every `nativelink-cas-` cache by age and kept the
// two newest, prefix-blind. With two prefixes live, both survivors can belong to
// the SAME prefix -- so the other prefix loses its only seed, and every job on
// that compiler builds cold until something reseeds it. The canary then reports
// NEW PREFIX (#1091), which is honest but indistinguishable from a roll nobody
// has seeded yet, so the eviction is invisible.
//
// Policy, and the two things it trades off:
//   * keep GENERATIONS newest caches per prefix, so a live compiler always has a
//     restore target;
//   * keep at most PREFIXES prefixes, newest first, so dead compiler
//     combinations do not accumulate against the repository's 8 GiB budget
//     (cache-hygiene.yml). A prefix nothing has used recently is exactly what a
//     retired toolchain leaves behind.
//
// Reads the `gh api .../actions/caches` payload on stdin, writes `id key size`
// for every cache to DELETE on stdout. Deciding and deleting are separate so the
// decision can be tested; an inline jq expression in a workflow cannot be.
import { readFileSync } from "node:fs";

// One generation is sufficient because `restore-keys` returns the most
// recently created match, so a single seed per prefix always has a target.
export const GENERATIONS = 1;
// Four, and the number is derived rather than picked. The prefix is
// rustc x cc (#1088), and BOTH are two-valued at the same time during an
// overlap: rustc while a toolchain roll is in flight, cc while a runner image
// rolls out. 2 x 2 = 4 live combinations, and retiring one of them evicts a
// live seed -- this file's own bug, at arity 4. Three would have flapped:
// whichever combination was seeded least recently loses, every time.
//
// Budget: cas-inrunner caps the CAS at 1 GiB plus a 200 MB action cache, so
// four prefixes is ~4.8 GiB worst case against cache-hygiene's 8 GiB. That is
// a real increase over the old rule's ~2.4 GiB, and it is the cost of not
// evicting live seeds; the store is still under budget and still unprotected,
// so hygiene can reclaim it under pressure.
export const PREFIXES = 4;
const SELECT = "nativelink-cas-";

/** The prefix a key belongs to: everything before its trailing run id.
 *
 * Keys are `<prefix><github.run_id>` and run ids are digits, so the prefix is
 * the key with its trailing digits removed. A key with no trailing digits is
 * its own prefix rather than an error -- it is still a cache under our
 * selector, and dropping it from the plan would silently exempt it from
 * pruning forever.
 */
export function prefixOf(key) {
  return key.replace(/\d+$/, "");
}

export function plan(payload, { generations = GENERATIONS, prefixes = PREFIXES } = {}) {
  // `actions_caches` must be an ARRAY, not merely present. An object or a
  // string threw `TypeError: .filter is not a function` from inside plan(),
  // which is fail-safe from the CLI (no stdout, so no deletions) but throws
  // for any other caller and made the "does not throw" test a lie.
  const all = Array.isArray(payload?.actions_caches) ? payload.actions_caches : [];
  const caches = all.filter((c) => typeof c?.key === "string" && c.key.startsWith(SELECT));

  const byPrefix = new Map();
  for (const cache of caches) {
    const prefix = prefixOf(cache.key);
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(cache);
  }

  const by = (field) => (a, b) => String(b[field] ?? "").localeCompare(String(a[field] ?? ""));
  // WITHIN a prefix, newest CREATED first: `restore-keys` returns the most
  // recently created match, so that is the one a restore will actually get and
  // therefore the one to keep.
  const newestCreated = by("created_at");
  // ACROSS prefixes, most recently USED first. Retirement means "nothing has
  // needed this compiler lately", which is last_accessed_at -- the field the
  // API itself sorts by default. Ranking on created_at retires a combination
  // that dev seeds rarely but PRs restore from constantly, while a combination
  // seeded once and never used again outranks it.
  const lastUsed = by("last_accessed_at");
  const groupActivity = (group) => group.reduce(
    (newest, c) => (lastUsed(newest, c) > 0 ? c : newest),
    group[0],
  );

  const ranked = [...byPrefix.values()]
    .map((group) => ({ group: [...group].sort(newestCreated), activity: groupActivity(group) }))
    .sort((a, b) => lastUsed(a.activity, b.activity));

  const doomed = [];
  ranked.forEach(({ group }, index) => {
    // Whole prefix retired: it is not among the most recently used `prefixes`.
    if (index >= prefixes) doomed.push(...group);
    // Live prefix: keep its newest `generations`.
    else doomed.push(...group.slice(generations));
  });
  return doomed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // stdin only. A `--file` flag existed with no caller anywhere, and `--file`
  // with no value threw ERR_INVALID_ARG_TYPE from OUTSIDE the try below, so the
  // one path that skipped the fail-closed message was the unused one.
  const raw = readFileSync(0, "utf8");
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    // Fail closed: deleting nothing is always safe, deleting on a guess is not.
    console.error(`prune-plan: could not parse the caches payload (${error.message}); planning no deletions`);
    process.exit(1);
  }
  for (const cache of plan(payload)) {
    process.stdout.write(`${cache.id} ${cache.key} ${cache.size_in_bytes ?? 0}\n`);
  }
}
