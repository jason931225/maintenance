# KNL design doctrine

**One company, coherent product principles, explicit visual authorities. Best practice only.**

The public web, legacy application, and target Console are one product and share universal
principles: Korean-first copy, WCAG AA, reduced-motion support, honest content, no stubs, canonical
object identity, and audited/policy-gated actions. They do **not** share one visual component system.

This document's palette, typography, layout, and `web/src/components/ui/**` rules govern the public
web and legacy application. Accepted ADR-0025 governs the isolated target under
`web/src/console/**`; its visual authority is `docs/design/oyatie-console/**`, and it does not inherit
legacy shell/UI/page visuals. The two surfaces share the nonvisual platform spine—auth, contracts,
policy, audit, realtime, i18n, telemetry, and E2E—during measured convergence.

## 1. Storefront and legacy tokens (`web/src/styles.css` @theme)
`ink #101820` · `signal #f6b521` (amber) · `signal-dark #c88800` · `brand-teal #0f766e`
· `steel #51606c` · `line #d7dee5` · `muted-panel #eef2f5`. Within the storefront/legacy scope,
**no raw hex** in components
(`#050d14`, `#f6f8fa`, `#14120c` are forbidden — use `ink` / `muted-panel`). Semantic use:
ink = dark surfaces/headings; signal = primary CTA + dark-surface accents; brand-teal =
light-surface accents; steel = body; line = borders; muted-panel = alt section bg.

## 2. Storefront and legacy typography
- Hero H1 `clamp(40px,6vw,72px)` leading-[1.05] tracking-[-0.02em] `font-extrabold`, max-w-[820px].
- Section H2 `clamp(28px,3.4vw,44px)` leading-[1.12] `font-extrabold`.
- Body `text-steel` 17–18px leading-[1.7]. Reserve `font-extrabold`/`font-black` for H1–H3 + CTAs.
- **One eyebrow rule:** 12–13px `font-black uppercase tracking-[0.14em]`, **brand-teal on light /
  signal on dark**. Never brand-teal on ink (fails AA, 3.27:1).

## 3. Storefront and legacy spacing and layout
Content bands `py-[clamp(72px,9vw,120px)]`; accent bands `py-[clamp(40px,5vw,64px)]`. One inner
width `max-w-[1240px]`, one padding rhythm `px-5 sm:px-8 lg:px-12`. 8pt rhythm inside components.

## 4. Storefront and legacy components — KNL primitives (no slate)
The shared `web/src/components/ui/*` (Button/Card/Badge/Input/Select/Textarea) are KNL-tokened for
the storefront and legacy application,
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

## 8. Surface doctrine — coherent product, distinct visual systems
- **Public web and legacy application** — this doctrine's KNL brand system, with marketing
  spaciousness or legacy operational density as appropriate.
- **Target carbon-copy Console** — the denser ontology/window/object grammar in
  `docs/design/oyatie-console/**`, isolated under `web/src/console/**` per ADR-0025.

Coherence comes from product vocabulary, accessibility, canonical objects, policy/audit behavior,
and the shared platform spine—not from forcing the homepage palette or legacy components into the
carbon-copy surface. The legacy visual system is removed only after ADR-0025's rollout and deletion
gates pass.

## 9. Enforcement
Universal gates: `eslint --max-warnings 0`, `check-ui-strings`, `tsc -b`, `vite build`, the vitest
suite, and real-backend browser E2E. Storefront/legacy visual changes cite this doctrine and match the
homepage reference. Carbon-copy changes cite ADR-0025 plus the nearest
`docs/design/oyatie-console/**` authority and pass its fidelity, accessibility, performance,
full-stack, and persona gates. Reviewers reject cross-boundary visual imports as well as unsupported
one-off deviations within either authority.
