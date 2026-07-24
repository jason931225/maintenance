# CAP-EQUIPMENT-3R-PILOT frontend — stage-2 adversarial verification

Fresh-eyes verification of `web/src/console/equipment/**` (code authored by the
stage-1 build session, verified and amended by a separate session, 2026-07-24).

## Commands run (final state, after fixes)

| Command | Result |
| --- | --- |
| `npx vitest run src/console/equipment` | 4 files, 29/29 passed |
| `npx eslint src/console/equipment src/i18n/equipment.ts --max-warnings 0` | clean |
| `node scripts/check-ui-strings.mjs` | exit 0 |
| `node scripts/check-console-purity.mjs` | OK — 411 files clean (className literal gate) |
| `npx tsc -b` | exit 0 |
| grep `TODO\|FIXME\|test.skip\|.only\|cn(\|clsx` over module | no hits |

## Findings (found this stage, fixed this stage)

1. **Dead quote control on non-AVAILABLE units** (`EquipmentUnitDetail.tsx`).
   The quote form was gated on `availability !== "SOLD"`, so RESERVED /
   ON_RENT / IN_* / FOR_SALE units — which already carry an active case or an
   open disposition — rendered a form whose submit could only 409. Same defect
   class as the disposition gate stage 1 fixed. Now `=== "AVAILABLE"`; test
   asserts the form is absent on an ON_RENT unit while the active-case link
   stays traversable.
2. **Un-clearable filter dead-end** (`EquipmentScreen.tsx`). Stat-bar filter
   chips rendered only at count > 0, so when the active filter's last member
   left on refresh the chip vanished, the filter could never be cleared, and
   the list claimed "등록된 장비가 없습니다" while units existed. The active
   filter's chip now stays rendered at 0, and a filtered-empty state
   (`unitsFilteredEmpty` / `casesFilteredEmpty`, manifested in `i18n.json`)
   replaces the false global empty message. Test drives the full trap:
   filter → refresh to 0 → truthful message → chip still clearable.
3. **Stepper untruth on DECLINED cases** (`EquipmentCaseDetail.tsx`).
   `stepClass` indexed against `HAPPY_PATH`, so on a declined case the QUOTED
   step (which did occur) rendered as not-done. Now indexed against the
   rendered sequence; test asserts QUOTED = done, DECLINED = `aria-current`.

Stage 1's own fix (disposition OPEN/COMPLETED derived from
`unit.openDispositionId`, form only while truly open) re-verified against the
code and its two tests; holds.

## Module completion contract (docs/program/console-enterprise-roadmap.md)

| Point | Verdict | Evidence |
| --- | --- | --- |
| List/overview layer | PASS | availability board + rental pipeline, compact stat-bar chips as filters (no KPI cards) |
| Object detail layer | PASS | `EquipmentUnitDetail`, `EquipmentCaseDetail`; loading/error/retry per detail |
| Action/workflow layer | PASS | 9 actions (register, quote, approve/decline, dispatch, handover, inspect, return, assess, complete-disposition), each with failure exposure + backend reconciliation (`transition()` refetch; approval-reconciliation test) |
| History layer | PASS | unit history readback (`GET /units/{id}/history`), inspection log on case detail |
| ≥2 upstream / ≥2 downstream links | PASS with note | unit → active case, unit history case entries → case, case → unit, lists → both details. Dispositions are not traversable objects — the contract has no `GET /dispositions/{id}` (contract-level constraint, not a UI omission) |
| Server-enforced authz, deny-by-omission | PASS | per-feature capabilities hide affordances entirely (never disabled ghosts); denied-observe fetches nothing (test); four-eyes mirror hides approval from the quote creator (test); authz projection fails closed to JWT floor |
| Keyboard/focus/contrast/Korean/responsive | PASS | real buttons throughout (Enter-activation test), `:focus-visible` outlines, all colors via `tokens.css` custom properties (verified each var exists; `color: white` on teal matches the production.css exemplar), flex-wrap layouts for Hangul expansion, 900px single-column breakpoint |
| Selection + draft survive refresh | PASS | selection in sessionStorage per branch; quote draft + Idempotency-Key in localStorage per branch+unit; remount test proves the stored key is the one sent and cleared on success |
| Truthful states | PASS | loading / empty / filtered-empty / denied / error+retry all backend-derived; disposition OPEN/COMPLETED derived from `unit.openDispositionId` |

## API fidelity

`docs/evidence/console/CAP-EQUIPMENT-3R-PILOT/design-contract.md` lives in the
backend worktree and is not visible here; no separate api-fragment manifest
exists in this evidence dir (mount.json `transport` is the closest artifact).
Verified against the stage-1 contract digest: 14 routes under
`/api/v1/equipment-3r`, camelCase DTOs, `{"error":{"code","message"}}`
envelope (fallback message on non-envelope bodies), `Idempotency-Key` on quote
creation with 200 `replayed:true` pass-through, XOR completion body
(cost vs saleAmount+buyer), encoded path segments — all covered by
`equipmentApi.test.ts`. **Contract sync must be re-verified at consolidation
against the backend lane's committed design-contract.md.**

## Residual gaps (carried, not fixable in this lane)

- Module is dark until the integrator applies `manifests/mount.json`
  (EXPOSED_SCREEN_KEYS deliberately not requested per ADR-0025).
- Transport is raw fetch until openapi.yaml + generated clients land
  (backend lane owns the openapi manifest); swap path documented in
  `equipmentApi.ts` header.
- A disposition completed in another session shows a truthful COMPLETED chip
  but no amounts (contract has no `GET /dispositions/{id}`).
- No end-to-end run against the real backend (built in parallel from the same
  contract); verification is fetch-boundary component tests per lane charter.
- `web/src/i18n/equipment.ts` sits outside the strict ownership roots but
  follows the mandated production-module exemplar; ko.ts untouched.
