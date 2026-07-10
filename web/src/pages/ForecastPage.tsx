import { PageHeader } from "../components/shell/PageHeader";
import { PageEmpty } from "../components/states/PageEmpty";
import { ko } from "../i18n/ko";

/**
 * Forecast (분석 › 예측) — forward-looking operational/financial projections.
 * wire-pending: Phase B/C adds the forecast series + scenario views; this stub
 * reserves the route and nav slot.
 */
export function ForecastPage() {
  return (
    <>
      <PageHeader title={ko.nav.forecast} />
      <PageEmpty />
    </>
  );
}
