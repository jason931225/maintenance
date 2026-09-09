---
id: ADR-0043
status: proposed
doc_status: review
date: 2026-09-08
owner: jasonlee
decision: required-ci-coverage
proposes_amendments_to: []
related: [ADR-0039, ADR-0042]
---

# ADR-0043 — What `Required / CI` is allowed to not cover

## Status

**Proposed 2026-09-08.** States a measured gap and its options. Decides
nothing, amends nothing, clears no HOLD.

**Measured at `51d939dc`, 2026-09-09.** Every count and job state below is
anchored to that tip and is not maintained afterwards: this record is a
measurement and should be read as one. The exception is configuration the
options are priced against -- how the workflow and the branch are set up, cited
by `ci.yml` line reference, plus the absence of a merge queue on `dev` and of any
workflow holding `issues: write`. Those are kept current, because a change to
any of them reprices an option.

ADR-0042 records the SSR authorization transport. The two are independent
findings that share one shape -- a green signal whose name claims more coverage
than it has -- and neither depends on the other.

## Context

`Required / CI` is a merge-blocking context on `dev` with
`enforce_admins: true`. It is an aggregate job that waits on six others:
`preflight`, `rust-fmt`, `postgres-domain-reachability`, `repo-gates`,
`api-contract`, `kubernetes-manifests`.

Five job families are **not** in that list and are gated to
`github.event_name == 'push' || github.event_name == 'workflow_dispatch'`:
`backend` (cargo and buck legs), `domain-unit`, `company-conformance`,
`generated-faces`, and the migration expand/contract rehearsal. They run after
the merge lands on `dev`.

This is deliberate and documented in the workflow. The measurement it rests on
(`ci.yml:1888-1892`, merge_group 33137386975, 2026-08-28) reads
"PostgreSQL platform 16.9m + preflight 2.0m = 19.2m because Required / CI waited
on every heavy proof". Note what that decomposition says: **16.9 of the 19.2
minutes is `Test PostgreSQL — platform`, a job that is still inside the
aggregate today** via `postgres-domain-reachability`. Path-gating Postgres is
what bought the fast presubmit; removing the five families is not. A separate
measurement (`ci.yml:959-960`, merge_group 32402124838) prices the backend
family at "the 17m critical path of a 19m CI run". Those are two numbers from
two runs and must not be fused into one.

"Sub-5m" also holds only for the fast leaves. A candidate touching
live-Postgres paths still waits on jobs carrying `timeout-minutes: 45`.

### What it costs, measured

**62** consecutive CI runs on `dev`, as of run 33499949213 on tip `f44add94`,
are a workflow **failure** whose `Required / CI` job **succeeded**, ending at
run 33393757000 (2026-08-31), the most recent run where the aggregate itself
failed. The streak is still running: 65 as of `51d939dc`, after three merges
that each landed on a red branch. 85 `dev` runs are red overall at that tip;
62 is the deliberate subset where the gate wrongly passed,
which is what this record is about -- the other 20 include runs where
`Required / CI` correctly failed, and folding those in would inflate the number
with evidence *for* the gate. On the tip `f44add94`
(run 33499949213):

| Job | Result |
|---|---|
| `Required / CI` | success |
| `Backend — cargo` (both arches) | failure |
| `Backend — buck-app` | failure |
| `Company conformance` | failure |
| `Generated faces — full required drift authority` | failure |

The branch has been red across 62 consecutive integration runs and no gate
objected, because the gate does not look there. `dev`'s entire CI history is 86
runs beginning 2026-08-30, so this is very nearly its whole life as the
integration branch -- not a long drift from a healthy state, but a branch that
has been red since shortly after it took the role. At least three independent breakages were
live on `dev` and unnoticed, each found only by running the suite by hand:

- `cargo clippy --all-targets -- -D warnings`, seven lint sites across six
  crates (#1072).
- `env!("CARGO_PKG_VERSION")` in `crates/contracts` (#1015), which Cargo defines
  and Buck2 does not, breaking every Buck target that depends on contracts
  (#1076).
- `[unsupported-ddl]` from the personal-data-classification gate on
  `0225_mandatory_group_of_one.sql`: the parser did not recognise
  `DROP INDEX IF EXISTS`, so the gate declined to certify the file. That
  migration came from #971, merged 2026-08-29 — before `dev`'s first push run.

Nothing hid any of them, and that is the sharper point. Steps in this job carry
`if: ${{ !cancelled() && … }}` precisely so a red step does not skip the ones
after it, and the job comment records the same fail-slow rule. Every one of the
three was individually red, on its own named step row, on `dev`'s first push
run and on every run since that executed the backend job. The one exception
proves the same rule from the other side: `dev`'s single green run,
33302380321, is green because a docs-only path class left `run_heavy` false and
skipped that job entirely, so the gate emitted no step row at all. They were not
buried; they were simply never read, because the job is postsubmit-only and
outside `Required / CI`, so a red step blocked no merge and produced no
obligation for anyone.

This enumeration is not known to be complete. It also closes a loop with
`docs/current/ROADMAP.md` item 3, which already documents open
migration-parser gaps of exactly this class: a known-incomplete gate ran
postsubmit-only, so its findings reached no one.

None of the three could have blocked the merge that introduced it, and each
reached `dev` through a pull request whose own checks were green.

### The part that is not a tradeoff

A context named `Required / CI`, enforced with `enforce_admins`, reads as *the*
CI gate. Nothing at the protection layer says which proofs it covers. A reader
of the branch settings, of `ROADMAP.md` item 3, or of a green PR cannot tell
that the compiler-lint and Buck legs are outside it. The speed decision is
defensible; the silence about its scope is what let a red branch look green
across 62 runs.

## Options

1. **Run the heavy families in the merge queue.** The workflow declares a
   `merge_group:` trigger, but **`dev` has no merge queue**:
   `mergeQueue(branch:"dev")` is null, all 160 merge_group runs in the
   repository's history are `gh-readonly-queue/main/...`, and all 86 `dev`
   integration runs are `push`. Adding `merge_group` to the five families would
   therefore produce exactly **zero** coverage on `dev` today. The option is
   really "enable a merge queue on `dev`, then do that" -- a protection change
   this record does not authorize, and a prerequisite that has to be named.
   Its cost is also not the amortization it appears to be: `main`'s queue runs
   `minimumEntriesToMerge: 1` and every sampled entry is a single pull request,
   so at the observed batch size of 1 this costs per change exactly what option
   2 costs, merely relocated from the pull request to the queue entry.
   Sequencing it behind a queue migration is the honest description.
2. **Make them presubmit-required.** Correct and simple. The cost is not the
   19.2m figure -- that is the Postgres critical path, which is already inside
   the aggregate -- but the backend family's own 17m measurement, on candidates
   whose path class triggers it.
3. **Report the red branch.** The release block already exists and already
   works. `image-release.yml` requires `.conclusion == "success"` on the whole
   exact-SHA `dev` postsubmit run (`:240`) and again on the aggregate job
   (`:258`), and that run is the one carrying all five excluded families.
   `ci.yml:1894-1895` says so inside the comment block this record already
   quotes: "Image-release still waits for the whole CI workflow on dev, so those
   proofs remain release evidence."

   So a red `dev` has made every release candidate inadmissible for the whole
   streak, and the train stopped without anyone deciding to stop it. What is
   missing is not the block but a durable, addressed obligation. There is **no
   repository-configured alerting**: zero repository webhooks, no workflow
   creating an issue, and no Slack, webhook, SMTP or paging secret to send one
   with. What does fire is GitHub's built-in Actions email to the actor who
   triggered the failed run — so a human has been told on every red run and it
   has not landed — plus two org-installed apps subscribed to `workflow_run`
   whose obligations this record cannot see. The defect is that none of those
   turns a red tip into something tracked.

   Its prerequisite, named rather than assumed: the cheap in-repo transport is
   issue creation, and **no workflow holds `issues: write`** today. `ci.yml`,
   `nightly.yml` and `security.yml` are `contents: read`; `image-release.yml` is
   `permissions: {}` under a documented deny-by-default posture. So this option
   costs a scoped widening of that posture on one workflow — no app install, no
   new secret, far less than a queue migration, but a deliberate exception to an
   invariant the repository treats as one.
4. **Rename the context to match its coverage.** `Required / Fast CI`, with the
   excluded families named in `docs/current/DELIVERY.md`. Costs nothing, fixes nothing, and
   stops the name from overclaiming.

## Recommendation

**Option 3, with option 4's naming change regardless of which is chosen.** It
is the only option that reaches `dev` as it is configured today, and it is much
cheaper than this record first assumed: the control already exists and already
fires, so the work is turning its output into a tracked obligation rather than
an email nobody acts on. A control that operates
correctly into silence is the same class of defect as a name that overclaims,
and this record now documents two instances of it rather than one.

Option 1 remains the better end state once a queue exists on `dev`, and the
queue migration is worth doing on its own merits -- but it is a sequenced
follow-on, not the smaller change, and pricing it as free amortization would be
wrong at the observed batch size of 1.

Neither option 1 nor 2 is a `needs:` append. All five families also carry
`needs.preflight.outputs.run_heavy == 'true'`, so on a docs-only candidate they
report `skipped`, and `skipped != success` in the aggregate's flat equality
chain -- naive inclusion would fail every docs-only merge, including this
record's own. Doing it correctly needs the `postgres-domain-reachability`
pattern: a fail-closed aggregator with explicit path-class skip proofs. That is
a materially larger change than "add them to `needs:`", and this record prices
it as such.

## Consequences

- Until this is decided, a green `Required / CI` is evidence about six job
  families and no others. Records that cite it as CI evidence should say which.
- `Backend — buck-app` will stay red under any option until `-ui` members are
  vendored into Buck generation (`docs/current/PRODUCT.md`); closing this gap
  makes that deferral **visible and blocking**, which is a real cost of options
  1 and 2 and has to be sequenced before either lands. It is already a release
  block under option 3; what changes is that someone would be told.
- This record authorizes no protection change, no workflow change, and no
  required-context edit. `docs/current/DELIVERY.md` already requires that a required context
  have an executable protected producer on every branch where it is enforced;
  nothing here relaxes that.
