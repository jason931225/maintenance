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

export const GENERATIONS = 1;
export const PREFIXES = 3;
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
  const caches = (payload?.actions_caches ?? []).filter((c) => typeof c?.key === "string" && c.key.startsWith(SELECT));

  const byPrefix = new Map();
  for (const cache of caches) {
    const prefix = prefixOf(cache.key);
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(cache);
  }

  const newestFirst = (a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""));

  // Rank prefixes by their own newest cache, so "which compiler is current"
  // is decided by recent use rather than by how many generations each holds.
  const ranked = [...byPrefix.entries()]
    .map(([prefix, group]) => ({ prefix, group: [...group].sort(newestFirst) }))
    .sort((a, b) => newestFirst(a.group[0], b.group[0]));

  const doomed = [];
  ranked.forEach(({ group }, index) => {
    // Whole prefix retired: it is not among the newest `prefixes`.
    if (index >= prefixes) doomed.push(...group);
    // Live prefix: keep its newest `generations`.
    else doomed.push(...group.slice(generations));
  });
  return doomed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const raw = readFileSync(process.argv.includes("--file") ? process.argv[process.argv.indexOf("--file") + 1] : 0, "utf8");
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
