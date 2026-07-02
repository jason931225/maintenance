import { chromium } from '@playwright/test';

const checkedAt = new Date().toISOString();
const consoleMessages = [];
const pageErrors = [];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
page.on('console', (msg) => consoleMessages.push({ type: msg.type(), text: msg.text() }));
page.on('pageerror', (err) => pageErrors.push(String(err?.message ?? err)));

let gotoResult = null;
try {
  const response = await page.goto('https://console.knllogistic.com/financial?tab=purchase', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await page.waitForFunction(
    () => window.location.pathname === '/login' || document.body.innerText.includes('로그인'),
    null,
    { timeout: 15_000 },
  ).catch(() => undefined);
  gotoResult = {
    status: response?.status() ?? null,
    url: response?.url() ?? null,
    finalUrl: page.url(),
    title: await page.title(),
  };
} catch (error) {
  gotoResult = { error: String(error) };
}

const bodyText = await page.locator('body').innerText({ timeout: 10_000 }).catch((error) => `BODY_READ_FAILED: ${String(error)}`);
const localStorage = await page.evaluate(() => Object.fromEntries(Object.entries(window.localStorage))).catch((error) => ({ error: String(error) }));
const cookies = await context.cookies();
const protectedResponse = await page.request.get('https://console.knllogistic.com/api/v1/financial/purchase-requests/preferences').catch((error) => ({ error: String(error) }));
let protectedResult;
if ('error' in protectedResponse) {
  protectedResult = protectedResponse;
} else {
  protectedResult = {
    status: protectedResponse.status(),
    body: await protectedResponse.text(),
  };
}

const output = {
  checkedAt,
  browser: {
    engine: 'chromium',
    userAgent: await page.evaluate(() => navigator.userAgent).catch(() => null),
    viewport: page.viewportSize(),
  },
  navigation: gotoResult,
  bodyText,
  consoleMessages,
  pageErrors,
  localStorage,
  cookies: cookies.map(({ name, domain, path, expires, httpOnly, secure, sameSite }) => ({ name, domain, path, expires, httpOnly, secure, sameSite })),
  protectedPreferencesWithoutAuth: protectedResult,
};
console.log(JSON.stringify(output, null, 2));

await browser.close();
