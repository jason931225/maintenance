# KNL design doctrine

**One company, one design philosophy, one doctrine. Best practice only.**

The FSM operator console and the public web are **one product**. They share this design
language exactly — same tokens, type, components, a11y, motion, voice. They differ only in
**density** (see §8), never in brand. Every page, current and future, conforms. No exceptions,
no off-brand console primitives, no one-off palettes. When in doubt, match the redesigned
public homepage (`web/src/pages/StorefrontHomePage.tsx`).

## 1. Tokens — the only palette (`web/src/styles.css` @theme)
`ink #101820` · `signal #f6b521` (amber) · `signal-dark #c88800` · `brand-teal #0f766e`
· `steel #51606c` · `line #d7dee5` · `muted-panel #eef2f5`. **No raw hex** in components
(`#050d14`, `#f6f8fa`, `#14120c` are forbidden — use `ink` / `muted-panel`). Semantic use:
ink = dark surfaces/headings; signal = primary CTA + dark-surface accents; brand-teal =
light-surface accents; steel = body; line = borders; muted-panel = alt section bg.

## 2. Typography — one scale
- Hero H1 `clamp(40px,6vw,72px)` leading-[1.05] tracking-[-0.02em] `font-extrabold`, max-w-[820px].
- Section H2 `clamp(28px,3.4vw,44px)` leading-[1.12] `font-extrabold`.
- Body `text-steel` 17–18px leading-[1.7]. Reserve `font-extrabold`/`font-black` for H1–H3 + CTAs.
- **One eyebrow rule:** 12–13px `font-black uppercase tracking-[0.14em]`, **brand-teal on light /
  signal on dark**. Never brand-teal on ink (fails AA, 3.27:1).

## 3. Spacing & layout
Content bands `py-[clamp(72px,9vw,120px)]`; accent bands `py-[clamp(40px,5vw,64px)]`. One inner
width `max-w-[1240px]`, one padding rhythm `px-5 sm:px-8 lg:px-12`. 8pt rhythm inside components.

## 4. Components — KNL primitives (no slate)
The shared `web/src/components/ui/*` (Button/Card/Badge/Input/Select/Textarea) are KNL-tokened,
not slate. Buttons: **primary** `bg-signal text-ink`; **secondary-dark** `border-white/35 bg-white/10
text-white`; **secondary-light** `border-ink text-ink`. `min-h-[52px]` (44px in headers/dense
console). `rounded`. Cards: 12px radius, 1px `line` border, contained image `object-cover` with
`motion-safe:group-hover:scale-105` + ink→transparent gradient.

## 5. Accessibility — WCAG AA, non-negotiable
Every interactive element has a visible **focus-visible** ring (`outline-2 outline-offset-2`,
signal/ink/white as the surface demands). Every `<section>` is `aria-labelledby` an id'd heading.
Decorative/background images are `aria-hidden`; meaningful images keep real alt text. Tap targets
**≥44px**. Full keyboard operability; no icon-only controls without an aria-label. Contrast ≥4.5:1
normal / 3:1 large — verify on dark (`white/70` ok, brand-teal-on-ink not) and amber (ink text).

## 6. Motion — restraint
Only small hover translate (≤2–3px) + card image-zoom (≤1.04) + static hero scale-1.03. **All**
transforms gated under `motion-safe:`. No parallax, no autoplay, no position jumps for reduced-motion.

## 7. Content & voice
Korean-first; **all** visible copy lives in `web/src/i18n/ko.ts` (the check-ui-strings gate forbids
inline Hangul). **Online-centric — phone is a last resort.** No fabricated metrics/testimonials,
no stubs, no lorem, no filler, no dead-end screens. Real content only. No orphaned i18n keys.

## 8. Density doctrine — same language, two densities
- **Public web** — marketing spaciousness: generous bands, large type, hero imagery, one primary CTA.
- **FSM console** — functional density: compact tables, dense forms, dashboards, the wall-board.
Same tokens/type/components/focus/voice; the console simply tightens spacing and scales type down a
step. It must still unmistakably read as the same company as `knllogistic.com`.

## 9. Enforcement
Gates: `eslint --max-warnings 0`, `check-ui-strings`, `tsc -b`, `vite build`, the vitest suite, and
the browser-E2E suite (catches console regressions). Every UI change cites this doctrine; reviewers
reject deviations. New work matches the homepage reference. Implemented by task #42 (console↔web
unification) and applied to all pages.
