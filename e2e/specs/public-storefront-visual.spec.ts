import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

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

      await expect(page).toHaveScreenshot(route.snapshot, {
        fullPage: true,
        maxDiffPixelRatio: 0,
      });
    });
  }
});
