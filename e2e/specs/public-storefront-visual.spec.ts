import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

/**
 * Baseline snapshots live in `public-storefront-visual.spec.ts-snapshots/` and
 * are named per-platform by Playwright (`*-chromium-linux.png`). CI
 * (`.github/workflows/ci.yml` browser-e2e job) runs on `ubuntu-latest`, so the
 * committed baselines must be generated on Linux, not a local macOS/Windows
 * checkout — regenerate them via the pinned Playwright Docker image so the
 * render matches CI's Chromium build exactly:
 *
 *   docker run --rm -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.61.0-noble \
 *     bash -lc "npm ci && npx playwright test e2e/specs/public-storefront-visual.spec.ts --update-snapshots"
 *
 * A bare local `--update-snapshots` on macOS writes `*-chromium-darwin.png`
 * files that CI never reads — don't commit those.
 */
const PUBLIC_ROUTES = [
  { path: "/", snapshot: "storefront-home.png" },
  { path: "/rental", snapshot: "storefront-rental.png" },
  { path: "/used", snapshot: "storefront-used.png" },
  { path: "/support/new", snapshot: "storefront-support-new.png" },
] as const;

const STATIC_PREVIEW_FALLBACK = process.env.E2E_STATIC_PREVIEW_FALLBACK === "1";
const DIST_DIR = join(process.cwd(), "web", "dist");

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function contentTypeFor(pathname: string) {
  return MIME_TYPES[extname(pathname)] ?? "application/octet-stream";
}

test.describe("UI-M1a public storefront visual guard", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("knl_cookie_notice_v2", "acknowledged");
    });

    if (STATIC_PREVIEW_FALLBACK) {
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith("/api/v1/storefront/listings")) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ items: [], limit: 24, offset: 0, total: 0 }),
          });
          return;
        }

        const pathname =
          url.pathname === "/" || !extname(url.pathname)
            ? "/index.html"
            : url.pathname;
        const filePath = normalize(join(DIST_DIR, pathname));
        if (!filePath.startsWith(DIST_DIR)) {
          await route.abort();
          return;
        }

        try {
          await route.fulfill({
            status: 200,
            contentType: contentTypeFor(pathname),
            body: await readFile(filePath),
          });
        } catch {
          await route.abort();
        }
      });
      return;
    }

    await page.route("**/api/v1/storefront/listings**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [], limit: 24, offset: 0, total: 0 }),
      });
    });
  });

  for (const route of PUBLIC_ROUTES) {
    test(`${route.path} matches the committed storefront snapshot`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 1100 });
      await page.goto(route.path);
      await page.waitForLoadState("networkidle");

      // The footer's "버전 vX.Y.Z" stamp reads web/package.json's version at
      // build time, so every `chore(main): release X.Y.Z` bump changes those
      // pixels for a commit that never touched the storefront. A Playwright
      // `mask` is NOT enough here: the stamp is right-anchored, so a version
      // whose glyphs render even a sub-pixel wider shifts the element's
      // bounding box — and the mask box tracks that bbox, leaving a ~1px
      // sliver of unmasked pixels that fails under `maxDiffPixelRatio: 0`
      // (observed: 0.1.42 baseline vs a 0.1.43 build differed by 17 px at the
      // stamp's left edge on all four routes). Hide the stamp instead:
      // `visibility: hidden` renders the region as plain footer background
      // regardless of the version string's content OR width, so the committed
      // baselines stay valid across every release. Screenshot-only — this
      // never touches how production renders the version.
      await page.addStyleTag({
        content:
          '[data-testid="storefront-footer-version"]{visibility:hidden !important;}',
      });

      await expect(page).toHaveScreenshot(route.snapshot, {
        fullPage: true,
        maxDiffPixelRatio: 0,
      });
    });
  }
});
