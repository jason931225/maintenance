import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");

const lightTokens = {
  "console-canvas": "#f2f4f7",
  "console-surface": "#ffffff",
  "console-muted": "#eceff3",
  "console-border": "#dbe1e8",
  "console-border-soft": "#e8ecf1",
  "console-ink": "#141a21",
  "console-steel": "#566475",
  "console-faint": "#616e7e",
  "console-signal": "#f6b521",
  "console-signal-deep": "#e2a30d",
  "console-teal": "#0f766e",
  "console-danger-bg": "#fef2f2",
  "console-danger-bd": "#fca5a5",
  "console-danger-tx": "#b91c1c",
  "console-danger-solid": "#dc2626",
  "console-warn-bg": "#fffbeb",
  "console-warn-bd": "#fcd34d",
  "console-warn-tx": "#92400e",
  "console-warn-solid": "#b45309",
  "console-ok-bg": "#ecfdf5",
  "console-ok-bd": "#6ee7b7",
  "console-ok-tx": "#065f46",
  "console-ok-solid": "#059669",
  "console-info-bg": "#eff6ff",
  "console-info-bd": "#93c5fd",
  "console-info-tx": "#1e40af",
  "console-accent-bg": "#fffbeb",
  "console-accent-bd": "#f6b521",
  "console-accent-tx": "#78350f",
  "console-purple-bg": "#f5f3ff",
  "console-purple-bd": "#c4b5fd",
  "console-purple-tx": "#5b21b6",
  "console-shadow": "0 1px 2px rgba(20, 26, 33, 0.05)",
  "console-shadow-pop": "0 12px 32px rgba(20, 26, 33, 0.16)",
} as const;

const darkTokens = {
  "console-canvas": "#0e1319",
  "console-surface": "#161c24",
  "console-muted": "#1f2731",
  "console-border": "#2b3542",
  "console-border-soft": "#232c37",
  "console-ink": "#e8edf4",
  "console-steel": "#9cabbc",
  "console-faint": "#8b98a7",
  "console-signal": "#f6b521",
  "console-signal-deep": "#ffc93d",
  "console-teal": "#2dd4bf",
  "console-danger-bg": "#3a1214",
  "console-danger-bd": "#7f2b2b",
  "console-danger-tx": "#fda4a4",
  "console-danger-solid": "#f87171",
  "console-warn-bg": "#3a2606",
  "console-warn-bd": "#92610a",
  "console-warn-tx": "#fcd34d",
  "console-warn-solid": "#fbbf24",
  "console-ok-bg": "#062e22",
  "console-ok-bd": "#0b6e51",
  "console-ok-tx": "#6ee7b7",
  "console-ok-solid": "#34d399",
  "console-info-bg": "#14243f",
  "console-info-bd": "#2d5eb8",
  "console-info-tx": "#93c5fd",
  "console-accent-bg": "#362605",
  "console-accent-bd": "#a97b06",
  "console-accent-tx": "#fcd34d",
  "console-purple-bg": "#271449",
  "console-purple-bd": "#6d43c0",
  "console-purple-tx": "#c4b5fd",
  "console-shadow": "0 1px 2px rgba(0, 0, 0, 0.4)",
  "console-shadow-pop": "0 16px 40px rgba(0, 0, 0, 0.55)",
} as const;

function blockFor(selector: string) {
  const lines = css.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines.slice(index, index + 2).join("\n");
    if (!header.includes("{")) continue;
    const selectorList = header
      .slice(0, header.indexOf("{"))
      .split(",")
      .map((entry) => entry.trim());
    if (!selectorList.includes(selector)) continue;

    const start = css.indexOf("{", css.indexOf(lines[index]));
    const end = css.indexOf("}", start);
    const block = css.slice(start + 1, end);
    if (block.includes("--console-")) return block;
  }

  throw new Error(`Missing CSS block for ${selector}`);
}

function relativeLuminance(hex: string) {
  const channels = hex.replace("#", "").match(/.{2}/g);
  if (!channels || channels.length !== 3) {
    throw new Error(`Invalid hex color ${hex}`);
  }

  const [r, g, b] = channels.map((value) => {
    const channel = Number.parseInt(value, 16) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground: string, background: string) {
  const [lighter, darker] = [
    relativeLuminance(foreground),
    relativeLuminance(background),
  ].sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

// Composite `top` over `bottom` at `alpha`, the way an `rgb(...)/40%` layer
// paints over an opaque background. Used to reconstruct the unread-notification
// row (bg-console-muted/40 over surface) that faint timestamps actually sit on.
function composite(top: string, bottom: string, alpha: number) {
  const channel = (hex: string, i: number) =>
    Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const mixed = (i: number) =>
    Math.round(alpha * channel(top, i) + (1 - alpha) * channel(bottom, i));
  return `#${[0, 1, 2].map((i) => mixed(i).toString(16).padStart(2, "0")).join("")}`;
}

function tokensIn(block: string) {
  return Object.fromEntries(
    Array.from(block.matchAll(/--([\w-]+):\s*([^;]+);/g), ([, name, value]) => [
      name,
      value.trim(),
    ]),
  );
}

describe("Oyatie console CSS tokens", () => {
  it("matches the prototype light token family", () => {
    expect(tokensIn(blockFor(".console"))).toMatchObject(lightTokens);
  });

  it("keeps faint text AA-readable on console surfaces", () => {
    const light = tokensIn(blockFor(".console"));
    const dark = tokensIn(blockFor(".console.dark"));

    expect(
      contrastRatio(light["console-faint"], light["console-surface"]),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(dark["console-faint"], dark["console-surface"]),
    ).toBeGreaterThanOrEqual(4.5);

    // Comms-rail timestamps sit on the unread-notification row, which tints the
    // surface with console-muted at 40% opacity — a darker background than the
    // bare surface. faint must clear AA there too (regression: #687585 was
    // 4.44:1 on this composite and axe failed the populated rail).
    const lightUnread = composite(
      light["console-muted"],
      light["console-surface"],
      0.4,
    );
    const darkUnread = composite(
      dark["console-muted"],
      dark["console-surface"],
      0.4,
    );
    expect(
      contrastRatio(light["console-faint"], lightUnread),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(dark["console-faint"], darkUnread),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("flips every console token through the dark theme class", () => {
    const light = tokensIn(blockFor(".console"));
    const dark = tokensIn(blockFor(".console.dark"));

    expect(dark).toMatchObject(darkTokens);
    expect(Object.keys(darkTokens).sort()).toEqual(Object.keys(lightTokens).sort());
    for (const name of Object.keys(lightTokens)) {
      expect(dark[name]).toBeDefined();
      expect(light[name]).toBeDefined();
    }
  });
});

describe("Oyatie console light-default (authority: no OS auto-dark)", () => {
  it("never darkens the .console scope via prefers-color-scheme", () => {
    // Authority (docs/design/oyatie-console/tokens/colors.css): light default,
    // dark ONLY as an explicit opt-in (.console.dark / .console.t-dark, and the
    // carbon console's [data-console-theme="dark"]). An OS-preference auto-dark
    // block here force-darkened the carbon console — which signals its theme via
    // the data-console-theme attribute, not the .t-light/.dark classes — turning
    // light/system module surfaces black on dark-OS machines. The block is gone,
    // so blockFor can no longer find its selector.
    expect(() => blockFor(".console:not(.t-light):not(.dark)")).toThrow();
  });
});

describe("Oyatie console motion rules", () => {
  it("exposes reusable pop, toast, and pulse motion classes", () => {
    expect(css).toMatch(/@keyframes\s+pop-in\b/);
    expect(css).toMatch(/@keyframes\s+toast-in\b/);
    expect(css).toMatch(/@keyframes\s+pulse-dot\b/);
    expect(css).toMatch(
      /\.console-motion-pop\s*\{[^}]*animation:\s*pop-in\s+0\.14s\s+ease\s+both;/s,
    );
    expect(css).toMatch(
      /\.console-motion-toast\s*\{[^}]*animation:\s*toast-in\s+0\.18s\s+ease\s+both;/s,
    );
    expect(css).toMatch(
      /\.console-motion-pulse-dot\s*\{[^}]*animation:\s*pulse-dot\s+1\.2s\s+ease-in-out\s+infinite;/s,
    );
  });

  it("disables reusable motion for reduced-motion users", () => {
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.console-motion-pop,[\s\S]*\.console-motion-toast,[\s\S]*\.console-motion-pulse-dot\s*\{[\s\S]*animation:\s*none\s*!important;/,
    );
  });
});
