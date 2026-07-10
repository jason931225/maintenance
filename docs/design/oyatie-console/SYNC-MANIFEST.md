# SYNC-MANIFEST — claude.ai/design → local mirror

Source project: `claude.ai/design/p/9c7c313a-2187-4cf1-bb35-7c07ad0a4d9d` ("Oyatie Console")
Last sync: **2026-07-10 (delta pass)** via DesignSync read API. Purpose: offline continuity of the design authority.

## Etag record (from list_files this pass — cheap delta checks next time)
| file | etag | this pass |
|---|---|---|
| `AGENTS.md` | `1783689752100759` | **updated** (91→100) |
| `TODO.md` | `1783689758191741` | **updated** (실행 큐 체크·item16) |
| `DESIGN.md` | `1783659938373543` | unchanged (byte-identical, size 53176) |
| `HANDOFF.md` | `1783661269027052` | unchanged (byte-identical, size 36418) |
| `README.md` | `1783658590972921` | unchanged (size 6900) |
| `CLAUDE.md` | `1783552476465483` | unchanged (size 7384) |
| `ROADMAP.md` | `1783629404420364` | unchanged (size 28885) |
| `tokens/colors.css` | `1783156611028624` | unchanged upstream (divergence held — see below) |
| `Oyatie Console.dc.html` | `1783689684133230` | not fetched (1.7MB > 256KiB cap — change log = spec) |

## Fresh (this delta pass — byte-current with the live project)
- `AGENTS.md` — change log now through **(100)** (레인 10 증거 WORM 뷰어). THE definitive delta record + file map + 「다음」 pointer. New entries this pass: (92) benefit 카드 존 · (93) docs 카드 존(appr 제외) · (94) 대시보드 위젯 제네릭化 · (95) 기안 §68 투영·fail-closed · (96) 대시보드 실데이터 파생 · (97·98) 급여/공고/월간 J/K·aria · (99) 미편성 결원 SLO 알림 · (100) 증거 WORM 뷰어.
- `DESIGN.md` — charter through **§4-26 (SLO ≠ SLA)**; gained §4-25 폐루프 페이지 리뷰 프로토콜(8문) + §4-26 SLO≠SLA invariants, §4-20 온톨로지 엔진, §4-22/23 add-anything·창 모델·드래그 소스, §4-24 차트 정직 스케일링.
- `TODO.md` — worklist headed by the **▶ 실행 큐 (2026-07-10)** single-source order + **10 레인 계획** parallel fan-out scoreboard; ERP·파운드리 IA·구성 콘솔·규제 PII·인제스트·증거·오피스·DLP·mox epics. This pass: 실행 큐 items 1·2·3·5·9·17·10 flipped to `[x]` (AGENTS 91–100) + lane-2 gained a completion line (benefit/docs ✓, appr 제외); item 16 SLO 알림 시드 ✓. Queue **header/ordering unchanged**; 10 레인 계획 section byte-identical.
- `HANDOFF.md` — **newly mirrored locally** (was referenced but not on disk before). Backend contract §0–§20 through **§13.1 (Netflix급 DRM 연구 · directive 2026-07-10)** + §15 생애주기 엔진 · §16 가드레일 · §17 엔터프라이즈 표준 · §18 온톨로지 엔진 · §19 구성 콘솔 · §20 CRUD 감사 매트릭스.
- `README.md` — design-system guide; **WORKING PROTOCOL** (closed-loop improvement cycles, DESIGN §4-25) + content/visual foundations + anti-patterns.
- `CLAUDE.md` — session pointer (DESIGN/TODO/ROADMAP/AGENTS/HANDOFF 읽기 순서) + 핵심 원칙 요약 + 안티패턴.
- `ROADMAP.md` — master blueprint; module matrix + 진행 로그 through 2026-07-09 (온톨로지 엔진·워크플로 typed·actionable·인수인계 완결).
- `tokens/colors.css` — real console theme values (light/dark).

## ⚠️ Local-ahead-of-upstream divergence (do NOT clobber on next sync)
- `tokens/colors.css` light `--faint`: **upstream #8b98a7 → local #5f6d7e** (AA fix, 2026-07-09). **Verdict this delta pass (2026-07-10): upstream fetched — STILL ships #8b98a7 (etag unchanged 1783156611028624) — local #5f6d7e PRESERVED, divergence still OPEN.** The prototype value fails WCAG AA (2.66–2.93:1) on readable text (group labels, wordmark, placeholders); axe-proven against the built shell. Repo `web/src/console/tokens.css` carries the byte-mirrored fix (light #5f6d7e, dark #8492a3). **Upstream design project must adopt #5f6d7e** (tokens/colors.css + the dc.html `.console` theme block); until then, syncs must preserve this local value.

## Kept from prior mirror (not re-fetched)
- **`Oyatie Console.dc.html` (~698 KB)** — EXCEEDS the DesignSync 256 KiB per-file read cap. Kept intact. **Every change since Jul 4 is documented** in AGENTS.md §5 change log + ROADMAP 진행 로그 + TODO checkmarks — established pattern: the change-log = spec for post-Jul-4 screens. To get a bit-exact current copy: open the project in the browser and save/export manually.
- `Oyatie Mobile.dc.html`, `ios-frame.jsx` — mobile deliverable (iOS frame + 390px console iframe) + iOS 26 liquid-glass frame components.
- `AGENTS.md` exceeded the inline token cap on read this pass (98,703 bytes escaped) → auto-saved tool-result decoded byte-for-byte and written (zero transcription; local == upstream 98703 bytes). `TODO.md` returned inline (88,272 bytes) → applied as targeted diffs; verified local == upstream 88272 bytes.
- Local-only working docs retained: `AUTOMATION-POLICY-FIDELITY-SPEC.md`, `LEGACY-PARITY-BACKLOG.md`.

## Deliberately not mirrored
- `styles.css` (imports-only entry), `support.js` (DS glue), `tokens/{typography,spacing,elevation}.css` — not re-fetched this pass (unchanged upstream; re-fetch on demand).
- `pii/*.pdf` — regulatory reference PDFs (binary; near/over cap).
- `screenshots/*.png`, `uploads/*`, `.thumbnail` — illustrative/raw-input binaries, not design authority.
- `web/src/**` — snapshots OF THIS REPO's own web/src uploaded to the design project as references; canonical versions live in this repo.

## Canonical precedence when offline
1. `web/src/**` (this repo) — implementation truth.
2. This directory's fresh markdowns — design authority (AGENTS.md change log = single source of current design state).
3. `Oyatie Console.dc.html` (Jul 4) + AGENTS.md change log — prototype behavior reference; for post-Jul-4 screens, the change log + DESIGN §4.7 grammar catalog + §4-25 review protocol are the spec.
