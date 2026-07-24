# Console hyperscale fan-out epoch contract

**Status:** enforceable planning/admission contract. Buck2 remains the only
build and impact graph authority. This planner owns only immutable source
admission, writable-root collision avoidance, capacity admission, independent
review, and serialization of shared faces.

## Bind before dispatch

A receipt is bound to a full 40-character Git commit. The CLI reads the
registry and generated-face authority **from that commit**, requires its caller
worktree to be clean, requires `source_revision` to be a resolvable
`<ref>@<40-sha>` immutable provenance commit that is an ancestor of the anchor
(and whose locally resolvable ref is not behind it), and records SHA-256
authority digests. This avoids self-referential candidate-commit metadata while
still binding the actual registry and generated-face blobs to the anchor. Missing, empty, or
schema-incompatible generated-face authority fails closed.

Every declared ownership root is a repository-relative literal or a literal
with one terminal `/**`. Dot aliases, `..`, absolute paths, and wildcard forms
such as `foo*`, `**/file`, or brace/character globs are rejected. A generated
output pattern which cannot be represented by that algebra is conservatively
widened to its literal prefix subtree; this can reduce leaf concurrency but can
never create an unsound intersection result.

The migration authority is exactly
`backend/crates/platform/db/migrations/**`; it must exist in the anchor tree
and is excluded from all leaf writable roots.

## Safe parallelism

A source lane is admissible only with:

- unique owner, exact worktree, exact branch, signature story, evidence path,
  executable leaf gates, and required Buck targets;
- clean declared worktree discovered through `git worktree list --porcelain`,
  whose branch matches the declaration and whose HEAD is the anchor or an
  immutable descendant;
- one explicit integer resource declaration for `writer`, `postgres`,
  `browser`, `ios`, `graph`, and `cas`; and
- disjoint private roots.

The deterministic quality-weighted maximal independent set is bounded by the
writer budget and all resource budgets. Capacity or root collisions are explicit
holds, not silent scheduling omissions. Dependencies are merge holds, not an
excuse to block an otherwise safe leaf implementation.

Each selected lane receives a deterministic, epoch-scoped Buck isolation path:

```text
.buck2/console-epochs/<anchor-12>/<lane-slug>-<sha256(full-lane-id)>
```

Run Buck through `tools/buck2 --isolation-dir <that path> ...`. Concurrent
worktrees therefore cannot invalidate each other’s daemon due to constraints or
version drift. Reuse the same path inside a lane to preserve incremental local
state; remote/content caches remain shared. This changes no Buck cells or build
graph ownership.

## Review and consolidation

Shared OpenAPI, generated clients, migrations, route/nav, tokens, and generated
Buck faces are never leaf writes. A consolidation entry remains false until an
exact-anchor independent-review receipt is approved for every leaf and the
consolidation owner, worktree, branch, and resource declaration are valid. The
planner discovers the consolidation worktree through `git worktree list
--porcelain`, verifies its exact branch, cleanliness, anchor-descendant HEAD,
and that its resource demand fits the epoch capacity before it can be ready.
Each leaf receipt names its exact lane and implementer, a distinct reviewer, the
reviewed leaf commit, the SHA-256 leaf-result digest, and a review commit that
exists and descends from that leaf commit. Review fans out per leaf;
rejections return only to the leaf owner. The consolidated exact tip then runs
cheap admission, affected Buck targets, resource-class shards, browser stories,
and the full backstop.

The receipt is planning evidence, not a completion claim. A capability is done
only after its roadmap stories, real backend wiring, independent review,
shared-face consolidation, and exact-tip verification all pass.
