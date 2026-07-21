# PR 473 production-promotion authority

## Current state: blocked and nondeployable

`PR-473-PRODUCTION-PROMOTION.authorization.json` is the canonical production authorization record. It is intentionally false. `PR-473-PRODUCTION-CARDINALITY.evidence.json` is an invalid `TEMPLATE_NOT_EVIDENCE` document, not observed production evidence. Changing the authorization to true without replacing that template through the lineage below fails closed.

This mechanism does **not** make mutable `main` a safe production desired-state authority. The authorization record's machine-enforced `desired_state_authority_cutover` field is immutable `false` in schema v2, so `initial` rejects even an otherwise valid `C -> E -> A` lineage before mutation. Production activation remains **BLOCKED** until a separate, higher-authority ADR is accepted and its cutover establishes an immutable or otherwise race-safe production desired-state authority. Enabling that future cutover requires an explicit authorization-schema and checker-code change; editing evidence or setting `deployment_authorized` alone cannot bypass this block. PR 473 must not change the Argo Application target, live manifests, or claim that this unresolved mutable-main boundary is solved.

## Canonical evidence schema

The production-cardinality evidence is JSON with exact keys and types enforced by `scripts/check-production-promotion-authority.py`. An authorized document must contain:

- target `production`, release phase `expand`, the pre-evidence candidate source SHA, and the observed running revision;
- the observed cluster name, namespace, writer and reader endpoints, and a non-empty, unique instance list with exactly one ready primary and all other instances ready replicas;
- a bounded observation window, CPU, memory, storage, and connection peaks, limits, and a positive minimum headroom that the measurements actually preserve;
- a completed backup and later isolated-restore proof, restored revision, and non-empty validation checks;
- distinct evidence-author and independent-reviewer identities, including immutable identity-provider subjects;
- the independent reviewer's positive GitHub Team ID;
- charter `oyatie-production-change-authority-v1` in trust domain `oyatie-production-independent-review`; and
- ordered RFC3339 observation, preparation, and review timestamps.

The evidence bytes must be canonical two-space-indented JSON with exactly one trailing newline. Unknown keys, missing keys, wrong JSON types, zero or unreachable SHAs, a running revision that is not an ancestor of the candidate source, a restore revision different from the observed running revision, invalid timestamps, empty arrays, duplicate instances, false readiness, insufficient headroom, placeholder values (including `TEMPLATE_NOT_EVIDENCE`), unexpected charter or trust-domain identities, self-review, and evidence hash mismatches are rejected.

## Non-self-referential commit lineage

Let `C` be the fully validated candidate source commit, `E` the evidence-preparation commit, and `A` the authorization commit.

1. `C` contains a canonical false authorization record and is the SHA stored as `candidate_source_sha` in the later evidence.
2. `E` has exactly one parent, `C`, and changes exactly two paths: the canonical evidence JSON and the still-false authorization record's evidence SHA-256. The evidence author captures read-only production observations and the independent reviewer signs off under the named charter and trust domain.
3. `A` has exactly one parent, `E`, changes only the authorization record, and changes exactly `deployment_authorized` and `production_cardinality_evidence.verified` from false to true.
4. The promotion commit has exactly one parent, `A`, changes only the authorization reset and optionally the production overlay, and consumes the one-shot authority by resetting it to canonical false.

The checker loads the engineering gate, authorization, and evidence using `git show <sha>:<path>`, verifies the evidence SHA-256, and rejects extra paths, merge commits, wrong parents, dirty tracked worktrees, and an advanced `origin/main`.

## Protected environment contract

The protected production job requires `actions: read`, loads the expected Team ID and reviewer identities from the immutable authorized evidence, and verifies the GitHub `production` environment has one required-reviewers rule with `prevent_self_review: true`. The workflow accepts only the first run attempt, requires `github.actor` and `github.triggering_actor` to match, and requires that dispatcher to differ from both the evidence author and independent evidence reviewer. The environment rule must have exactly one reviewer entry, its type must be `Team`, and its documented nested `reviewer.id` must equal the immutable evidence Team ID. Evidence author and independent reviewer identities must also differ. Missing environment data, a mismatched Team, a flat or malformed reviewer object, an additional user reviewer, a user substituted for the Team, disabled self-review prevention, a rerun, or a dispatcher/evidence-role collision fails closed.

The evidence document's GitHub logins and identity-provider subjects are self-asserted strings whose provenance is not authenticated by this checker. This PR also does not verify the actual environment approval event provenance or repository/environment administrator bypass posture. Those are explicit future activation blockers; the schema and static workflow checks do not establish independent production authorization.

These checks reduce authorization ambiguity; they do not replace the pending desired-state-authority ADR/cutover and do not authorize production activation while that block remains.
