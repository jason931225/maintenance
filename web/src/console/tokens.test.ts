import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Carbon console token scope vs the committed design authority. Guards the
// "module surfaces render black in light mode" regression: the console must be
// light by default (authority is light-default, dark is an explicit opt-in) and
// an explicit dark theme must darken the whole surface, chrome AND content.
const tokens = readFileSync(join(process.cwd(), "src/console/tokens.css"), "utf8");
const mirror = readFileSync(
  join(process.cwd(), "../docs/design/oyatie-console/tokens/colors.css"),
  "utf8",
);

// Token blocks here have no nested braces, so first `}` closes the rule.
function blockAfter(css: string, header: string) {
  const at = css.indexOf(header);
  if (at === -1) throw new Error(`Missing selector ${header}`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

function decl(block: string, name: string) {
  const m = block.match(new RegExp(`--${name}:\\s*([^;]+);`));
  return m ? m[1].trim() : undefined;
}

// Surface/ink tokens are what paint the module background; these are the ones
// the black-in-light-mode defect got wrong. (Not asserting the full family: the
// dark --faint carries a pre-existing intentional divergence, out of scope.)
const SURFACE = ["canvas", "surface", "muted", "ink"] as const;

describe("carbon console tokens match the design authority", () => {
  it("light .console surfaces equal the mirror :root light values", () => {
    const consoleLight = blockAfter(tokens, ".console {");
    const mirrorLight = blockAfter(mirror, ":root {");
    for (const t of SURFACE) {
      expect(decl(consoleLight, t)).toBe(decl(mirrorLight, t));
    }
    expect(consoleLight).toMatch(/color-scheme:\s*light/);
    // Local AA fix (SYNC-MANIFEST divergence) must survive.
    expect(decl(consoleLight, "faint")).toBe("#5f6d7e");
  });

  it("dark theme surfaces equal the mirror dark values", () => {
    const consoleDark = blockAfter(tokens, `.console[data-console-theme="dark"]`);
    const mirrorDark = blockAfter(mirror, `[data-theme="dark"], .t-dark {`);
    for (const t of SURFACE) {
      expect(decl(consoleDark, t)).toBe(decl(mirrorDark, t));
    }
    expect(consoleDark).toMatch(/color-scheme:\s*dark/);
  });

  it("cascades the dark theme to nested module .console surfaces", () => {
    // Only the console root carries data-console-theme; module screens render a
    // nested .console scope. Without this the shell went dark but content stayed
    // light. The dark rule must also target that descendant.
    expect(tokens).toMatch(
      /\.console\[data-console-theme="dark"\]\s+\.console/,
    );
  });

  it("stays light by default — no OS prefers-color-scheme auto-dark", () => {
    expect(tokens).not.toMatch(/prefers-color-scheme/);
  });
});
