# Acme Group Design System

Extracted from the **Acme Group Console** — a Palantir-benchmarked, ontology-first B2B SaaS console for conglomerate HR/operations (근태·급여·연차·복리후생·채용·전자결재·문서·권한정책, with built-in messenger/mail/notification). Source of truth: `Oyatie Console.dc.html` (the working console) + `DESIGN.md` (design charter) + `TODO.md` (roadmap) at project root. Korean-first UI.

> This DS is **foundation-first and in progress**: tokens, styles, and this guide are done. Components, specimen cards, and UI kits are on the TODO list (#45–48) and still to be authored.

## Sources
- `Oyatie Console.dc.html` — full working console (all screens, tokens, patterns). The real values in `tokens/*` come from its `.console` theme block.
- `DESIGN.md` — ontology-first charter: 3-layer ontology (semantic/kinetic/dynamic), object catalog, Cedar PBAC, no-code, UI/UX invariants (§4), pattern-propagation (§4.7).
- `TODO.md` — roadmap with per-module best-in-class benchmarks.

## CONTENT FUNDAMENTALS (copy & tone)
- **Language**: Korean-first, formal-operational (합니다체 in toasts/guidance; noun-phrase labels elsewhere). No emoji. No marketing fluff.
- **Density over prose**: labels are terse noun phrases (재직 인원, 결재 대기, 예외 검토). Status is a **chip**, never a sentence. Numbers/time/codes in monospace.
- **No explanatory UI** (DESIGN.md invariant §12): if a control needs a caption to be understood, it's wrong. Background policy (audit, mobile parity) lives in docs, not on screen.
- **Object codes** as first-class copy: `AP-3121`, `WO-2643`, `AT-0703-02`, `C-207`, `JL-0703`. Toasts state result + path ("AP-3124 상신 완료 — 결재선 …").
- **Units & basis always stated**: "전월 +1.8%", "SLA 42분", "기한 7/8".

## WORKING PROTOCOL — closed-loop improvement cycles (DESIGN §4-25)
Work in incremental, systematic, thorough improvement loops — verify each loop until everything checks and is satisfactory. For every user-visible page, ask in closed loop: ① is this the most intuitive, ergonomic, best-in-class pattern — configurable, reproducible, maintainable — and can it be better? ② does it capture the module's workflow and the entire business-operations workflow, incl. nuances/edge cases? ③ foresee frictions and user troubles; follow natural eye/information flow. ④ benchmark against researched domain best-in-class (§4-21 three questions). ⑤ is the module tightly integrated with the rest, fully reusing shared components (§4-18)? ⑥ **mock-independence**: would this module — and the whole console — work without stub/mock data today? Every datum must be state-derived (editable via UI) or have a UI creation path; hardcoded-only data or stub behavior is a gap to register and close (backend-only items become HANDOFF contracts, never an excuse for a missing UI path).

## ANTI-PATTERNS — DO NOT (recurring; enforce)
- **No explanatory subtext/captions**: no subtitles under headers, no tech/protocol captions (e.g. "mox · IMAP4/SMTP"), no meta-notes ("이 열람은 감사됨"), no prose that restates what a chip or icon already shows. Status is a **chip**; only action-driving copy (warnings/errors) is allowed.
- **No non-functional text / data slop**: no labels, badges, numbers, stats, or icons that aren't clickable/draggable/filterable. A noun is an object (click/drag) or it isn't on screen.
- **No AI-slop visuals**: no gradient backgrounds, no emoji (unless brand), no rounded-container-with-left-border-accent, no overused fonts (Inter/Roboto/Arial). Color comes from tokens/brand only.
- **No big-number KPI cards** → compact 1-row stat bars (DESIGN §4-11). **No filler content** (dummy sections to fill space).
> The UI must be self-explanatory. If it needs a caption to be understood, it's wrong. (DESIGN §4-12 · §4.6)

## VISUAL FOUNDATIONS
- **Color**: near-white canvas `#f2f4f7`, white surfaces, hairline borders `#dbe1e8`. Ink `#141a21` / steel `#566475` / faint `#8b98a7` text tiers. Brand = **amber `#f6b521`** (primary actions, active accents), teal secondary. Semantic families (danger/warn/ok/info/accent/purple) each ship bg+bd+tx(+solid) — used as **tinted chips**, not fills. Full dark theme mirrors every token.
- **Type**: Pretendard Variable. Tight scale (13px base UI, 17px screen title, 20px KPI value). Weights 500/700/800, 900 for the logo mark. `letter-spacing:-0.3px` on headings. `word-break:keep-all`.
- **Shape**: radii 5px chips → 8px buttons/inputs → 11px cards; 50% avatars. Cards = white surface + hairline border + `--shadow` (0 1px 2px). Modals/pinned/popovers use `--shadow-pop`.
- **Layout**: 3-column shell (sidebar · main · comms rail). Compact 1-row stat bars, not big number cards (invariant §11). Lists share one track formula (no per-row max-content). Narrow/split viewport → cards stack vertically. Trailing spacer + bottom fade on scroll lists; `overscroll-behavior:contain`.
- **Motion**: restrained. `pop-in` (0.12–0.15s ease) for popovers/cards, `toast-in` (0.18s), `pulse-dot` for urgent SLA. `prefers-reduced-motion` respected. Hover = border→steel or bg→muted; press = opacity ~0.85. No bounce, no purple gradients.
- **Interaction grammar** (propagates everywhere, §4.7): J/K/Enter list nav + selection ring (inset 2.5px signal); column-drag resize (8px tick, readability floor); workspace cards move/resize/minimize/float/split with 1s-hover toolbar; detail opens as a **pinned quadrant panel** by default; menus close on outside-click/Esc.

## ICONOGRAPHY
- **Inline SVG, stroke style** — 24×24 viewBox, `stroke="currentColor"`, `stroke-width` ~2, round caps/joins (Lucide-family geometry, hand-inlined in the console; sizes 11–18px). No icon font, no PNG icons, **no emoji**, no unicode-glyph icons.
- Brand mark: a rounded amber square with a single bold letter (`A`) — there is **no supplied logo file**; render the letter mark / brand name in type. Do not reconstruct a logo.
- Substitution note: if you need a broader icon set, link **Lucide** from CDN (matches the console's stroke geometry) and flag it.

## Index (manifest)
- `styles.css` — entry (imports only).
- `tokens/` — `colors.css`, `typography.css`, `spacing.css`, `elevation.css` (real console values).
- `DESIGN.md`, `TODO.md`, `CLAUDE.md` (root) — charter + roadmap + session pointer.
- `Oyatie Console.dc.html` (root) — the live console this DS is extracted from.
- **TODO (this DS)**: specimen cards (Colors/Type/Spacing/Brand), components (Button·Chip/StatusChip·StatBar·ObjectRow·PinPanel·SidebarNav), UI kits (개요·인사·근태·전자결재), SKILL.md — items #45–48.

## Caveats
- Foundation only so far — no components/cards/UI-kits/SKILL.md yet.
- No logo asset provided; letter-mark used.
- Pretendard loaded via CDN; no local font binaries copied.
