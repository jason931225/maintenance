# DeepSWE v1.1 — Model-Routing Brief (W0 scout)

Source: https://deepswe.datacurve.ai — benchmark v1.1 (June 2026), 113 original
long-horizon feature tasks across 91 repos, 5 languages. Data pulled from the
site's own artifacts (not the JS-rendered UI), so the numbers below are the
real aggregates the dashboard computes, not screen-scrapes:

- `GET /artifacts/v1.1/leaderboard-live.json` — all 13 models × effort sweep, pass@1/@4 + cost/steps/tokens
- `GET /artifacts/v1.1/heatmap.json` — per (model, task) rollout counts (8 models only — see limits)
- `GET /artifacts/v1.1/tasks.json` — per-task language + repo (lets us join heatmap → language)
- `GET /artifacts/v1.1/tasks/<id>.json` — full task bundle incl. verifier (instruction, tests, grader)

Extraction is reproducible; raw files cached in `/tmp` during the scout run.

---

## 1. Overall leaderboard (pass@1, best effort per model)

| Rank | Model | eff | pass@1 | ±CI | pass@4 | $ median | steps | out-tok |
|---|---|---|--:|--:|--:|--:|--:|--:|
| 1 | **gpt-5.6-sol** | max | 72.7% | ±3 | 85.8% | $6.84 | 53 | 59k |
| 2 | **claude-fable-5** | xhigh | 69.9% | ±3 | 88.5% | $11.34 | 62 | 76k |
| 3 | gpt-5.6-terra | max | 69.6% | ±3 | 88.5% | $4.11 | 71 | 71k |
| 4 | gpt-5.6-luna | max | 67.2% | ±4 | 90.3% | $2.29 | 92 | 70k |
| 5 | gpt-5.5 | xhigh | 67.0% | ±6 | 88.5% | $6.11 | 76 | 44k |
| 6 | claude-opus-4.8 | max | 59.0% | ±2 | 79.3% | $12.35 | 116 | 129k |
| 7 | claude-sonnet-5 | max | 53.8% | ±4 | 78.8% | $23.28 | 260 | 204k |
| 8 | gpt-5.4 | xhigh | 51.8% | ±2 | 77.9% | $4.35 | 63 | 67k |
| 9 | glm-5.2 | max | 43.8% | ±2 | 77.0% | $3.46 | 123 | 76k |
| 10 | gemini-3.5-flash | med | 37.4% | ±2 | 66.4% | $6.28 | 82 | 255k |
| 11 | kimi-k2.7-code | – | 30.5% | ±1 | – | $2.82 | 149 | 59k |
| 12 | claude-sonnet-4.6 | high | 29.9% | ±4 | – | $5.52 | 134 | 76k |
| 13 | gemini-3.1-pro | high | 11.8% | ±2 | – | $9.48 | 81 | 196k |

**Headline reading:** top-3 (sol / fable-5 / terra) are a statistical tie —
their CIs overlap. Rank is decided by cost/steps, not capability. gpt-5.6-sol
matches Claude fable-5's accuracy at ~60% of the cost and fewer steps.

### Efficiency frontier (why the codex family looks strong)
The effort sweep is where the codex advantage is real. Same accuracy, far less spend:

| Config | pass@1 | $ median | steps |
|---|--:|--:|--:|
| gpt-5.6-sol [high] | 69.4% | **$2.98** | **32** |
| claude-fable-5 [max] | 69.7% | $19.23 | 79 |
| claude-fable-5 [xhigh] | 69.9% | $11.34 | 62 |
| gpt-5.6-terra [max] | 69.6% | $4.11 | 71 |

gpt-5.6-sol [high] delivers Claude-fable-5-max accuracy at **1/6 the cost and
40% the steps.** For high-volume lanes that is the whole ballgame.

---

## 2. Per-language pass rate — THE ROUTING-CRITICAL TABLE (+ its limit)

Computed by joining `heatmap.json` cells → task language. pass% = passing
rollouts / total rollouts (~4 rollouts/task). `(n)` = task count in language.

| Model | ALL | rust(5) | go(34) | py(34) | ts(35) | js(5) |
|---|--:|--:|--:|--:|--:|--:|
| **claude-fable-5** | **66.7%** | **67%** | **73%** | **68%** | **59%** | 65% |
| gpt-5.5 | 53.1% | 32% | 61% | 51% | 52% | 39% |
| gpt-5.4 | 51.8% | 40% | 63% | 46% | 50% | 35% |
| claude-opus-4.8 | 50.8% | 37% | 58% | 53% | 44% | 48% |
| gemini-3.5-flash | 37.4% | 35% | 40% | 37% | 35% | 45% |
| kimi-k2.7-code | 30.5% | 15% | 43% | 24% | 28% | 25% |
| claude-sonnet-4.6 | 29.9% | 35% | 26% | 29% | 32% | 40% |
| gemini-3.1-pro | 11.8% | 10% | 15% | 10% | 12% | 0% |

**The single most important finding:** in *every language the data can measure*,
**claude-fable-5 beats every GPT/codex model present.** There is no language
where an available codex model wins head-to-head. The provisional "codex is
better at Rust/systems / TS" intuition is **not supported** by DeepSWE.

### ⚠️ Two hard limits — read before acting
1. **The current codex leaders (gpt-5.6 sol/terra/luna) are NOT in the per-
   language heatmap.** Only 8 models are broken out, and of the top tier only
   claude-fable-5 is among them. So we can compare Claude vs *older* codex
   (5.4/5.5) by language, but we **cannot** confirm whether gpt-5.6-sol's
   top-line parity holds specifically on Rust or TS. Anyone claiming "codex
   wins Rust" has no DeepSWE evidence either way for the 5.6 family.
2. **Rust n=5 and JS n=5.** ~20 rollouts each. Error bars are enormous;
   language-specific Rust ranking is directional at best. Do **not** make a
   Rust-specific model bet on this alone — the signal is Go/Py/TS (n≈34).

---

## 3. Routing verdicts for the 5 provisionally-codex-marked lanes

Evidence base: Claude fable-5 leads every measurable language; codex's only
proven edge is cost/step efficiency at tied top-line accuracy; gpt-5.6 family
has no per-language breakout.

| Lane | Shape | Mark | Rationale (one line) |
|---|---|---|---|
| **BE-projected-dispatch** | Rust, systems-critical | **RESCIND → Claude** | No language where codex beats Claude fable-5; Rust n=5 too thin to bet against the measured leader; systems-critical wants the top-capability model, not the cheap one. |
| **BE-voucher-gl** | Rust, accounting | **RESCIND → Claude** | Money-path correctness = route to highest measured pass rate (fable-5 67% Rust / 66.7% overall), not the efficiency pick. |
| **BE-quant** | Rust, statistical | **RESCIND → Claude** | Same; plus statistical/numeric code rewards the model that also tops Python (fable-5 68%), the nearest measurable analog to quant work. |
| **FE-dynamic-grammar** | TS, parser-shaped | **RESCIND → Claude** | fable-5 leads TS outright (59% vs gpt-5.5 52% / gpt-5.4 50%). No codex TS advantage exists in the data. |
| **FE-policygate-bulk** | TS, security + **bulk/volume** | **KEEP codex — conditionally** | Only lane where the efficiency frontier justifies it: high-volume + TS where gpt-5.6-sol[high] gives ~parity accuracy at ~1/6 cost / 40% steps. BUT security correctness is the gate — if a run misses, escalate that item to Claude. Codex for throughput, Claude as the correctness backstop. |

**Net: rescind 4 of 5 codex marks; keep 1 conditionally on a cost/volume
basis, not a capability one.** The defensible policy for this repo's
enterprise-correctness bar (RLS/authz/audit/money paths): **default to
claude-fable-5 for correctness-critical lanes**; reserve codex (gpt-5.6-sol at
`high`, not `max`) for **high-volume or cost-bound lanes where a Claude
correctness pass still gates the merge.** Don't route Rust *to* codex on
capability grounds — the evidence points the other way, and the sample is too
small to argue from anyway.

---

## 4. Verifier patterns — reusable for our lane gates

DeepSWE's verifier is a clean, hardened **SWE-bench-style fail-to-pass /
pass-to-pass differential.** Every task ships a self-contained bundle
(`tasks/<id>.json` → 11 files: `instruction.md`, `task.toml`, `tests/config.json`,
`tests/grader.py`, `tests/test.patch`, `environment/Dockerfile`, oracle
`solution/`). Directly worth stealing for our gates:

1. **Oracle-vs-nop differential to derive the test whitelist.** They run the
   golden solution and an empty patch, and the tests that *flip* become
   `f2p_node_ids` (must go failing→passing = proves the feature). Tests that
   pass in both become `p2p_node_ids` (must stay green = no regression). This
   auto-generates a tight, non-gameable success set. → We can generate our
   own f2p list per story by diffing `cargo test` output at base vs at the
   golden patch, instead of hand-curating "which tests count."

2. **Two-list grading = feature-proof AND regression-proof in one gate.**
   f2p proves the work; p2p proves nothing else broke. Maps 1:1 onto our
   split: mnt_rt RLS/authz assertions as p2p (must never regress) + the
   story's new behavior tests as f2p. Our 21-gate web chain is the p2p
   analog; the per-slice user-story E2E is the f2p analog.

3. **Structured machine verdict, never log-scraping.** `test.sh` runs suites →
   emits `ctrf.json` (CTRF standard test-report) → `grader.py` reads it →
   writes `reward.json`. Reward convention worth copying:
   `-1` = harness/infra failure (excluded, not scored against the model),
   `0` = patch didn't even apply, else fraction of f2p passing.
   The key discipline: **provider/verifier/network errors are scored as
   "errored" and excluded from pass rate — only real solve/fail counts.** Our
   boot-smoke and visual-verdict lanes should distinguish "infra flake"
   (retry, don't count) from "genuine fail" (count) the same way.

4. **Hermetic, pinned, offline execution.** Per-task pinned Docker image,
   `allow_internet = false`, fixed CPU/mem/timeout (1800s verify, 5400s agent).
   No network during grading = no flake, no contamination. Our CI gates that
   touch the DB should assert the same isolation (already true for mnt_rt).

5. **Verifier code is shared verbatim + CI-checked across all tasks**
   (`tools/sync_verifier.py` enforces one canonical `grader.py`; per-task data
   lives only in `config.json`). Lesson for our gate binaries: one shared
   `mnt-gate-*` harness, per-lane data in config — not a bespoke script per
   lane. We already do this; DeepSWE validates the pattern at 113-task scale.

---

## TL;DR
- **gpt-5.6-sol tops the board (72.7%) but ties Claude fable-5 (69.9%) within CI**; its real edge is cost/steps, not capability.
- **claude-fable-5 wins every measurable language** (Rust/Go/Py/TS/JS) vs every codex model that IS broken out — but the 5.6 codex leaders are NOT in the per-language data, and Rust/JS are n=5 (weak signal).
- **Rescind 4/5 codex marks** (BE-projected-dispatch, BE-voucher-gl, BE-quant, FE-dynamic-grammar) → route to Claude on capability + correctness-criticality. **Keep FE-policygate-bulk on codex conditionally** — for throughput/cost, with a Claude correctness backstop on the security gate.
- **Verifier pattern to adopt:** oracle-vs-nop-derived f2p/p2p whitelists, structured `reward.json` verdict, infra-error exclusion, hermetic pinned offline runs, one shared grader + per-lane config.
