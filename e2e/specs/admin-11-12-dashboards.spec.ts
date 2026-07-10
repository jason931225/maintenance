import { test, expect } from "../fixtures/roles";

/**
 * ADMIN-11 — the KPI dashboard renders aggregated metrics on /kpi.
 * ADMIN-12 — the ops dashboard renders operational rollups on /ops.
 *
 * Both pages auto-load against the seeded org on first navigation. With the
 * systemic rfc3339 serde fix applied to the KPI Period (and analytics DTOs), the
 * report deserializes and the metric cards / rollups render rather than crashing
 * on an array-shaped timestamp. We assert the rendered Korean metric labels.
 */

test("ADMIN-11 KPI dashboard renders metric cards", async ({
  page,
  loginAs,
}) => {
  await loginAs("ADMIN");
  await page.goto("/kpi");
  await expect(
    page.getByRole("heading", { name: /임원 KPI 대시보드/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // The period field is present and pre-filled with the default range.
  await expect(page.getByLabel("기간").first()).toBeVisible();

  // Once the report loads, the metrics render as the §4-11 stat strip — every
  // metric is a drill link ("<label> <value> 상세 열기"). Their Korean labels are
  // the proof the report deserialized (a timestamp-as-array would have failed the
  // read and left the no-report empty state instead).
  await expect(
    page.getByRole("link", { name: /완료 건수.*상세 열기/ }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByRole("link", { name: /평균 응답 속도.*상세 열기/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /P1 수락률.*상세 열기/ }),
  ).toBeVisible();
});

test("ADMIN-12 ops dashboard renders operational rollups", async ({
  page,
  loginAs,
}) => {
  await loginAs("ADMIN");
  await page.goto("/ops");
  await expect(
    page.getByRole("heading", { name: /운영 대시보드/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // The funnel + alerts + equipment + mechanics sections render their headings.
  await expect(
    page.getByRole("heading", { name: /작업 흐름/ }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("heading", { name: /주의 지표/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /장비 상태/ })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /정비사 부하/ }),
  ).toBeVisible();

  // The funnel stage labels render (접수/배정/진행/완료).
  await expect(page.getByText(/접수/).first()).toBeVisible();
});
