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
  "console-faint": "#8b98a7",
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
  "console-faint": "#61707f",
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
