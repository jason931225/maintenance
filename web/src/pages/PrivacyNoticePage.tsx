import { ko } from "../i18n/ko";

const p = ko.storefront.privacyNotice;

const DETAIL_SECTIONS = [p.rights, p.processors, p.security, p.destruction, p.changes] as const;

function PolicyTable({
  labelledBy,
  headers,
  rows,
}: {
  labelledBy: string;
  headers: readonly string[];
  rows: readonly (readonly string[])[];
}) {
  return (
    <div className="mt-6 overflow-x-auto rounded-2xl border border-line bg-white">
      <table aria-labelledby={labelledBy} className="min-w-[860px] w-full border-collapse text-left text-sm">
        <thead className="bg-muted-panel text-ink">
          <tr>
            {headers.map((header) => (
              <th key={header} scope="col" className="border-b border-line px-4 py-3 font-extrabold">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="text-steel">
          {rows.map((row) => (
            <tr key={row.join("|")} className="align-top odd:bg-white even:bg-muted-panel/60">
              {row.map((cell, index) => (
                <td
                  key={`${row[0]}-${String(index)}`}
                  className="border-b border-line px-4 py-4 leading-6 last:border-b-0"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function PrivacyNoticePage() {
  const collectionRows = p.collection.rows.map((row) => [
    row.category,
    row.purpose,
    row.items,
    row.retention,
    row.required,
  ] as const);
  const cookieRows = p.cookies.rows.map((row) => [
    row.name,
    row.purpose,
    row.type,
    row.retention,
    row.control,
  ] as const);

  return (
    <main className="flex-1 bg-white">
      <section
        aria-labelledby="privacy-hero-title"
        className="bg-ink px-5 py-[clamp(80px,11vw,132px)] text-white sm:px-8 lg:px-12"
      >
        <div className="mx-auto max-w-[1240px]">
          <p className="mb-4 text-[13px] font-black uppercase tracking-[0.14em] text-signal">
            {p.hero.eyebrow}
          </p>
          <h1
            id="privacy-hero-title"
            className="balance-text m-0 max-w-[900px] text-[clamp(38px,6vw,72px)] font-extrabold leading-[1.08] tracking-[-0.02em]"
          >
            {p.hero.title}
          </h1>
          <p className="mt-6 max-w-[820px] text-[clamp(17px,2vw,22px)] leading-[1.7] text-white/80">
            {p.hero.copy}
          </p>
        </div>
      </section>

      <section className="px-5 py-[clamp(44px,6vw,80px)] sm:px-8 lg:px-12">
        <div className="mx-auto grid max-w-[1240px] gap-5 lg:grid-cols-[0.95fr_1.45fr]">
          <article className="rounded-2xl border border-line bg-muted-panel p-6 sm:p-8">
            <p className="mb-3 text-[12px] font-black uppercase tracking-[0.14em] text-brand-teal">
              {p.meta.title}
            </p>
            <dl className="grid gap-4 text-sm leading-6">
              <div>
                <dt className="font-extrabold text-ink">{p.meta.effectiveDateLabel}</dt>
                <dd className="m-0 mt-1 text-steel">{p.meta.effectiveDate}</dd>
              </div>
              <div>
                <dt className="font-extrabold text-ink">{p.meta.versionLabel}</dt>
                <dd className="m-0 mt-1 text-steel">{p.meta.version}</dd>
              </div>
              <div>
                <dt className="font-extrabold text-ink">{p.meta.operatorLabel}</dt>
                <dd className="m-0 mt-1 text-steel">{p.meta.operator}</dd>
              </div>
              <div>
                <dt className="font-extrabold text-ink">{p.meta.contactLabel}</dt>
                <dd className="m-0 mt-1 text-steel">{p.meta.contact}</dd>
              </div>
            </dl>
          </article>

          <div className="grid gap-4 sm:grid-cols-3">
            {p.summaryCards.map((card) => (
              <article key={card.title} className="rounded-2xl border border-line bg-white p-5 shadow-sm">
                <h2 className="m-0 text-lg font-extrabold leading-snug text-ink">{card.title}</h2>
                <p className="m-0 mt-3 text-sm leading-6 text-steel">{card.copy}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="px-5 pb-[clamp(48px,7vw,96px)] sm:px-8 lg:px-12">
        <div className="mx-auto max-w-[1240px] space-y-10">
          <article className="rounded-2xl border border-line bg-muted-panel p-6 sm:p-8">
            <p className="mb-3 text-[12px] font-black uppercase tracking-[0.14em] text-brand-teal">
              {p.collection.eyebrow}
            </p>
            <h2 id="privacy-collection-title" className="m-0 text-[clamp(26px,3vw,38px)] font-extrabold leading-[1.16] text-ink">
              {p.collection.title}
            </h2>
            <p className="mt-4 max-w-[900px] text-[16px] leading-[1.8] text-steel">{p.collection.copy}</p>
            <PolicyTable
              labelledBy="privacy-collection-title"
              headers={[
                p.collection.headers.category,
                p.collection.headers.purpose,
                p.collection.headers.items,
                p.collection.headers.retention,
                p.collection.headers.required,
              ]}
              rows={collectionRows}
            />
          </article>

          <article className="rounded-2xl border border-line bg-muted-panel p-6 sm:p-8">
            <p className="mb-3 text-[12px] font-black uppercase tracking-[0.14em] text-brand-teal">
              {p.cookies.eyebrow}
            </p>
            <h2 id="privacy-cookies-title" className="m-0 text-[clamp(26px,3vw,38px)] font-extrabold leading-[1.16] text-ink">
              {p.cookies.title}
            </h2>
            <p className="mt-4 max-w-[900px] text-[16px] leading-[1.8] text-steel">{p.cookies.copy}</p>
            <PolicyTable
              labelledBy="privacy-cookies-title"
              headers={[
                p.cookies.headers.name,
                p.cookies.headers.purpose,
                p.cookies.headers.type,
                p.cookies.headers.retention,
                p.cookies.headers.control,
              ]}
              rows={cookieRows}
            />
            <div className="mt-6 rounded-2xl border border-line bg-white p-5">
              <h3 className="m-0 text-lg font-extrabold text-ink">{p.cookies.browserControlTitle}</h3>
              <p className="m-0 mt-3 text-sm leading-6 text-steel">{p.cookies.browserControl}</p>
            </div>
          </article>

          <div className="grid gap-5 lg:grid-cols-2">
            {DETAIL_SECTIONS.map((section) => (
              <article key={section.title} className="rounded-2xl border border-line bg-white p-6 shadow-sm sm:p-8">
                <p className="mb-3 text-[12px] font-black uppercase tracking-[0.14em] text-brand-teal">
                  {section.eyebrow}
                </p>
                <h2 className="m-0 text-[clamp(24px,3vw,34px)] font-extrabold leading-[1.16] text-ink">
                  {section.title}
                </h2>
                <p className="mt-4 text-[16px] leading-[1.8] text-steel">{section.copy}</p>
                {"items" in section ? (
                  <ul className="mt-5 grid gap-2 pl-5 text-sm leading-6 text-steel">
                    {section.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : null}
              </article>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
