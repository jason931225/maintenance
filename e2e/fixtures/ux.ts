import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/**
 * Shared UX-best-practices verification layer for the browser-E2E suite.
 *
 * This is real UX verification per user story, not just functional assertion:
 *   (a) ZERO critical/serious axe accessibility violations per page,
 *   (b) NO uncaught console errors during the flow (fail on console.error),
 *   (c) loading/empty/error states render where applicable (spec-owned),
 *   (d) Korean i18n: no raw i18n keys leak (e.g. "nav.kpi") into visible text.
 *
 * It is deliberately pragmatic: only critical/serious axe impacts fail (minor
 * pre-existing nits do not), and the i18n probe only inspects user-visible text
 * nodes so legitimate code/slug strings are not flagged. Genuine a11y findings
 * are fixed in the app; any finding intentionally left unfixed is annotated with
 * a `// UX-DEBT` note at the call site rather than the rule being weakened.
 */

/** axe impact levels that FAIL a spec. Minor/moderate are reported-only. */
const BLOCKING_IMPACTS = ["critical", "serious"] as const;

/**
 * A console-error sink attached to a page. Call `assertClean()` after the flow
 * to fail the spec if the app logged any `console.error` (a strong signal of an
 * uncaught render/runtime error, a failed fetch surfaced to the console, or a
 * React warning escalated to error).
 */
export interface ConsoleGuard {
  /** All console.error message strings captured since attachment. */
  readonly errors: string[];
  /** Fail the spec if any console error was captured during the flow. */
  assertClean(): void;
}

/**
 * Benign console-error substrings to ignore. These are environment artifacts of
 * the e2e preview origin (plain http, no real network) — NOT app bugs. Keep this
 * list tight: anything app-originated must fail the spec.
 */
const IGNORED_CONSOLE_PATTERNS: RegExp[] = [
  // Vite preview serves over plain http; the browser may warn about insecure
  // contexts for clipboard / secure-context-only APIs in headless Chromium.
  /\[vite\]/i,
  // Favicon / static asset 404s on the preview origin are not app errors.
  /favicon\.ico/i,
  // ResizeObserver loop notices are a benign browser quirk, never an app bug.
  /ResizeObserver loop/i,
];

/**
 * Resource-load URLs whose failed-request console message is benign and must NOT
 * fail the flow. A failed-resource console error (e.g. "Failed to load resource:
 * the server responded with a status of 401") carries no URL in its `text()`, so
 * we scope the allowance by the message's `location().url` instead — keeping the
 * 401-as-bug assertion intact for every OTHER endpoint.
 */
const IGNORED_CONSOLE_URL_PATTERNS: RegExp[] = [
  // Boot silent-refresh: on a cold page load with no `mnt_refresh` cookie the app
  // probes `POST /auth/token/refresh`, which the backend answers 401; the app
  // catches it and renders the unauthenticated state. The browser still logs the
  // 401 network response — an expected cold-boot artifact, not an app error.
  /\/auth\/token\/refresh(?:$|\?)/,
];

/**
 * Start capturing `console.error` (and page `pageerror`) events on the page.
 * Attach BEFORE the first navigation so early-boot errors are caught too.
 */
export function attachConsoleGuard(page: Page): ConsoleGuard {
  const errors: string[] = [];

  const record = (text: string, url?: string) => {
    if (IGNORED_CONSOLE_PATTERNS.some((rx) => rx.test(text))) return;
    if (url && IGNORED_CONSOLE_URL_PATTERNS.some((rx) => rx.test(url))) return;
    errors.push(text);
  };

  page.on("console", (message) => {
    if (message.type() === "error") record(message.text(), message.location().url);
  });
  // Uncaught exceptions that never reach console.error still must fail the flow.
  page.on("pageerror", (error) => {
    record(error.message);
  });

  return {
    errors,
    assertClean() {
      expect(
        errors,
        `Expected no console errors during the flow, but got:\n${errors.join("\n")}`,
      ).toEqual([]);
    },
  };
}

/**
 * Assert ZERO critical/serious axe accessibility violations on the current page.
 * Scopes to the document; excludes nothing by default. Minor/moderate findings
 * are surfaced in the failure message context but do not fail the run.
 */
export async function assertNoAxeViolations(
  page: Page,
  options?: { context?: string },
): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  const blocking = results.violations.filter((v) =>
    (BLOCKING_IMPACTS as readonly string[]).includes(v.impact ?? ""),
  );

  const summary = blocking
    .map(
      (v) =>
        `  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s))\n` +
        v.nodes
          .slice(0, 3)
          .map((n) => `      - ${n.target.join(" ")}`)
          .join("\n"),
    )
    .join("\n");

  expect(
    blocking,
    `${options?.context ?? "page"} has critical/serious axe violations:\n${summary}`,
  ).toEqual([]);
}

/**
 * Assert no raw i18n keys (e.g. "nav.kpi", "financial.purchase.actions.submit")
 * leak into visible text. A leaked key means a `ko.*` lookup returned a missing
 * value or a component rendered the key path instead of the translation.
 *
 * Only user-visible text nodes are inspected, and `<code>/<pre>/<input>` and
 * elements with a `data-allow-keylike` opt-out are excluded so legitimate
 * code/slug/identifier strings are never flagged.
 */
export async function assertNoRawI18nKeys(page: Page): Promise<void> {
  const leaks = await page.evaluate(() => {
    // dotted lowercase path, 2+ segments, no spaces — the i18n key shape.
    const KEY_RE = /^[a-z]+(?:\.[a-z][a-z-]*)+$/;
    const SKIP_TAGS = new Set(["CODE", "PRE", "SCRIPT", "STYLE", "INPUT", "TEXTAREA"]);
    const found: string[] = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    let node = walker.nextNode();
    while (node) {
      const text = (node.textContent ?? "").trim();
      const parent = node.parentElement;
      const hidden =
        parent === null ||
        SKIP_TAGS.has(parent.tagName) ||
        parent.closest("[data-allow-keylike]") !== null ||
        parent.closest("code,pre") !== null;
      if (!hidden && text.length > 0 && KEY_RE.test(text)) {
        found.push(text);
      }
      node = walker.nextNode();
    }
    return Array.from(new Set(found));
  });

  expect(
    leaks,
    `Raw i18n keys leaked into the UI (untranslated): ${leaks.join(", ")}`,
  ).toEqual([]);
}

/**
 * One-shot UX audit for a settled page: no raw i18n keys, zero critical/serious
 * axe violations, and (when a guard is supplied) no console errors. Call once the
 * page's primary content has rendered (await its heading first).
 */
export async function auditPage(
  page: Page,
  options?: { context?: string; consoleGuard?: ConsoleGuard },
): Promise<void> {
  await assertNoRawI18nKeys(page);
  await assertNoAxeViolations(page, { context: options?.context });
  options?.consoleGuard?.assertClean();
}

/**
 * Navigate within the SPA by clicking the visible shell/link anchor for `href`.
 * This preserves the in-memory access token across authenticated role specs;
 * use `page.goto()` only when intentionally testing a full document reload and
 * silent-refresh recovery.
 */
export async function navigateByHref(page: Page, href: string): Promise<void> {
  const escaped = href.replace(/(["\\])/g, "\\$1");
  await page.locator(`a[href="${escaped}"]`).first().click();
  const path = href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await expect(page).toHaveURL(new RegExp(`${path}(?:$|[?#])`), {
    timeout: 15_000,
  });
}
