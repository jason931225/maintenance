import { ko } from "../i18n/ko";

const p = ko.storefront.privacyNotice;

const NOTICE_SECTIONS = [
  p.required,
  p.cookies,
  p.location,
  p.security,
  p.formalPolicy,
] as const;

export default function PrivacyNoticePage() {
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
            className="balance-text m-0 max-w-[860px] text-[clamp(38px,6vw,72px)] font-extrabold leading-[1.08] tracking-[-0.02em]"
          >
            {p.hero.title}
          </h1>
          <p className="mt-6 max-w-[760px] text-[clamp(17px,2vw,22px)] leading-[1.7] text-white/80">
            {p.hero.copy}
          </p>
        </div>
      </section>

      <section className="px-5 py-[clamp(60px,8vw,104px)] sm:px-8 lg:px-12">
        <div className="mx-auto grid max-w-[1240px] gap-5 lg:grid-cols-2">
          {NOTICE_SECTIONS.map((section) => (
            <article
              key={section.title}
              className="rounded-2xl border border-line bg-muted-panel p-6 sm:p-8"
            >
              <p className="mb-3 text-[12px] font-black uppercase tracking-[0.14em] text-brand-teal">
                {section.eyebrow}
              </p>
              <h2 className="m-0 text-[clamp(24px,3vw,34px)] font-extrabold leading-[1.16] text-ink">
                {section.title}
              </h2>
              <p className="mt-4 text-[16px] leading-[1.8] text-steel">
                {section.copy}
              </p>
              {"itemsTitle" in section ? (
                <dl className="mt-6 grid gap-4 border-t border-line pt-5 text-sm leading-6">
                  <div>
                    <dt className="font-extrabold text-ink">
                      {section.itemsTitle}
                    </dt>
                    <dd className="m-0 mt-1 text-steel">{section.items}</dd>
                  </div>
                  <div>
                    <dt className="font-extrabold text-ink">
                      {section.retentionTitle}
                    </dt>
                    <dd className="m-0 mt-1 text-steel">
                      {section.retention}
                    </dd>
                  </div>
                </dl>
              ) : null}
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
