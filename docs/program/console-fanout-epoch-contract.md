# Console hyperscale fan-out epoch contract

**Status:** implementation plan and admission contract.

This contract turns the console capability registry into bounded, exact-SHA
delivery epochs. It does not replace Buck2, infer source dependencies, or create
a second build graph. Buck2 remains the target/action authority; this planner
owns only work ownership, collision avoidance, review fan-out, and shared-face
serialization.

## Epoch phases

1. **Bind.** Record the full candidate SHA, registry digest, generated-face
   registry digest, resource budgets, and selected capability IDs. A changed
   anchor creates a new epoch.
2. **Leaf implementation.** Backend, frontend, user-story, and focused test
   lanes may run concurrently only when their writable roots are disjoint.
   Shared roots are removed from every leaf lane.
3. **Independent review.** Review is read-only and fans out per leaf result.
   Rejected findings return to the owning leaf lane; they do not widen another
   writer's ownership.
4. **Consolidation.** One owner applies OpenAPI, generated clients, migrations,
   console navigation/registry, design tokens, and other declared shared faces
   once on the exact epoch tip.
5. **Exact-tip verification.** Cheap admission precedes affected Buck targets,
   resource-class shards, browser stories, and the full backstop. Evidence is
   invalid after a rebase, merge-train reorder, or shared-face rewrite unless
   its action digest remains Buck-equivalent.

## Deterministic selection

For capability `i`, let:

- `s_i` be its existing risk-adjusted registry score;
- `c_i` be correctness/risk-reduction readiness;
- `v_i` be verification readiness;
- `β = 0.60`, the quality bias;
- `d_i` be its private-root collision degree.

The planner uses:

```text
quality_utility_i = (1 - β) * s_i + β * (c_i + v_i) / 2
selection_density_i = quality_utility_i / (1 + d_i)
```

It then constructs a deterministic weighted maximal independent set, bounded by
the writer budget. This is deliberately `O(V²)` and stable under identical
inputs. At repository scale, target impact and test selection come from Buck2
and Buck2 Change Detector; capability ownership remains a much smaller control
plane.

Shared roots do not create leaf conflicts. They create one ordered
consolidation queue. Private-root overlap, missing ownership, missing isolated
worktrees, absent signature stories, missing evidence paths, and missing leaf
gates fail closed.

Dependencies block merge admission, not safe source preparation. A leaf may
implement against an already-versioned port while its upstream capability is
unfinished, but the plan records that dependency as a merge hold.

## Concurrency and resource policy

- Writer fan-out is capped independently from read-only review fan-out.
- PostgreSQL, browser, iOS simulator, graph-construction, and CAS bandwidth
  receive separate resource budgets; job count is not a capacity model.
- A lane owns one worktree and one branch. The same writer never spans two
  capabilities inside an epoch.
- Generated outputs are never produced in leaf lanes. The consolidation owner
  regenerates from the merged sources once.
- New cells require a real trust, toolchain, configuration, or release
  boundary. Console modules remain packages and targets in the root cell.
- The safe fallback is broader execution or a smaller writer set, never skipped
  verification.

## Machine output

`scripts/console/plan-fanout.mjs` emits a stable JSON receipt containing:

- exact anchor and authority digests;
- selected leaf writers and their private/shared roots;
- held capabilities and admission reasons;
- private-root collision edges;
- unresolved merge dependencies;
- independent-review queue;
- single-writer consolidation queue.

The receipt is planning evidence, not completion evidence. A module is complete
only after its roadmap user stories, real backend wiring, independent review,
shared-face consolidation, and exact-tip verification pass.
