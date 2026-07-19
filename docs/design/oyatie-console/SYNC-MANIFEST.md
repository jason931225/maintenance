# SYNC-MANIFEST — historical upstream sync plus local truth amendments

Source project: `claude.ai/design/p/9c7c313a-2187-4cf1-bb35-7c07ad0a4d9d` ("Oyatie Console")
Last upstream sync: **2026-07-11 (delta pass)** via DesignSync read API. Local truth repair: **2026-07-18** against `origin/main@86a97771a76b7e770dfcf8c6c7d83fd9d70a98bf`. The three tracked Markdown files below are locally amended and are **not** byte-identical to that historical upstream snapshot.

## Etag record (from list_files this pass — cheap delta checks next time)

| file | etag | this pass |
|---|---|---|
| `AGENTS.md` | `1783710623650166` | historical upstream etag; locally amended/not byte-identical; final size **101957**, SHA-256 `1c22710aaed2df30e502f7039218f87c2c92c02b399217a408e4468dac71c6aa` |
| `TODO.md` | `1783710505767805` | historical upstream etag; locally amended/not byte-identical; final size **89636**, SHA-256 `06edb341bf4f50aee72721b7530841dae4489f417dd13c91715d9f37245393cd` |
| `ROADMAP.md` | `1783710735311137` | historical upstream etag; locally amended/not byte-identical; final size **32219**, SHA-256 `dabe2b756e75e9950a75bc0e270cc2aec6f9b97dad260beaf269de4821796228` |
| `DESIGN.md` | `1783659938373543` | unchanged (size 53176) |
| `HANDOFF.md` | `1783661269027052` | unchanged (size 36418) |
| `README.md` | `1783658590972921` | unchanged (size 6900) |
| `CLAUDE.md` | `1783552476465483` | unchanged (size 7384) |
| `tokens/colors.css` | `1783156611028624` | unchanged upstream (divergence held — see below) |
| `Oyatie Console.dc.html` | `1783710429913585` | not fetched (1.8MB > 256KiB cap — change log = spec) |

## Historical delta snapshot, followed by local amendments

- `AGENTS.md` — historical change log through **(101)** plus local truth amendments. It is a revision-bound design/prototype record, not implementation or readiness authority.
- `DESIGN.md` — charter through **§4-26 (SLO ≠ SLA)**; gained §4-25 폐루프 페이지 리뷰 프로토콜(8문) + §4-26 SLO≠SLA invariants, §4-20 온톨로지 엔진, §4-22/23 add-anything·창 모델·드래그 소스, §4-24 차트 정직 스케일링.
- `TODO.md` — historical worklist plus local layer labels that distinguish prototype/UI contracts from source-wired product and production evidence.
- `HANDOFF.md` — **newly mirrored locally** (was referenced but not on disk before). Backend contract §0–§20 through **§13.1 (Netflix급 DRM 연구 · directive 2026-07-10)** + §15 생애주기 엔진 · §16 가드레일 · §17 엔터프라이즈 표준 · §18 온톨로지 엔진 · §19 구성 콘솔 · §20 CRUD 감사 매트릭스.
- `README.md` — design-system guide; **WORKING PROTOCOL** (closed-loop improvement cycles, DESIGN §4-25) + content/visual foundations + anti-patterns.
- `CLAUDE.md` — session pointer (DESIGN/TODO/ROADMAP/AGENTS/HANDOFF 읽기 순서) + 핵심 원칙 요약 + 안티패턴.
- `ROADMAP.md` — historical blueprint plus a locally normalized 39-module layer matrix and truth caveats. Historical logs remain revision-bound and do not upgrade source presence to deployment or enterprise readiness.
- `tokens/colors.css` — real console theme values (light/dark).

## ⚠️ Local-ahead-of-upstream divergence (do NOT clobber on next sync)

- `tokens/colors.css` light `--faint`: **upstream #8b98a7 → local #5f6d7e** (AA fix, 2026-07-09). **Verdict this delta pass (2026-07-11): upstream colors.css etag UNCHANGED (1783156611028624) — not re-fetched (still ships #8b98a7) — local #5f6d7e PRESERVED, divergence still OPEN.** The prototype value fails WCAG AA (2.66–2.93:1) on readable text (group labels, wordmark, placeholders); axe-proven against the built shell. Repo `web/src/console/tokens.css` carries the byte-mirrored fix (light #5f6d7e, dark #8492a3). **Upstream design project must adopt #5f6d7e** (tokens/colors.css + the dc.html `.console` theme block); until then, syncs must preserve this local value.

## Kept from prior mirror (not re-fetched)

- **`Oyatie Console.dc.html` (~698 KB)** — EXCEEDS the DesignSync 256 KiB per-file read cap. Kept intact. **Every change since Jul 4 is documented** in AGENTS.md §5 change log + ROADMAP 진행 로그 + TODO checkmarks — established pattern: the change-log = spec for post-Jul-4 screens. To get a bit-exact current copy: open the project in the browser and save/export manually.
- `Oyatie Mobile.dc.html`, `ios-frame.jsx` — mobile deliverable (iOS frame + 390px console iframe) + iOS 26 liquid-glass frame components.
- The 2026-07-11 sync process reported byte equality for its then-current snapshot. Subsequent local amendments intentionally invalidate that identity; the current sizes and SHA-256 values are recorded in the table above.
- Local-only working docs retained: `AUTOMATION-POLICY-FIDELITY-SPEC.md`, `LEGACY-PARITY-BACKLOG.md`.

## Deliberately not mirrored

- `styles.css` (imports-only entry), `support.js` (DS glue), `tokens/{typography,spacing,elevation}.css` — not re-fetched this pass (unchanged upstream; re-fetch on demand).
- `pii/*.pdf` — regulatory reference PDFs (binary; near/over cap).
- `screenshots/*.png`, `uploads/*`, `.thumbnail` — illustrative/raw-input binaries, not design authority.
- `web/src/**` — snapshots OF THIS REPO's own web/src uploaded to the design project as references; canonical versions live in this repo.

## Canonical precedence when offline

1. Accepted repository ADRs and exact revision-bound source — architecture and implementation truth.
2. These locally amended Markdown files — design/prototype intent and work tracking, interpreted with explicit layer labels.
3. Historical upstream etags, `Oyatie Console.dc.html` (Jul 4), and dated change logs — revision-bound prototype references only.
