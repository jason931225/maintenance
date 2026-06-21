import { ko } from "../i18n/ko";

/**
 * About page (#6 KNL storefront). Routed child of PublicLayout — returns only
 * its own <main>; the dark site-header and footer come from the layout.
 *
 * Mirrors the static about.html sections: a dark photo page-hero (asset-17,
 * left gradient scrim), a Company split-panel intro, a muted Certification grid
 * (ISO 9001 / 14001 / 45001 → asset-08/09/10), and a Partners logo strip
 * (Toyota / Yale / Komatsu / BYD / HELI / Hangcha → asset-14/13/15/12/16/11).
 * All Korean copy is read from ko.storefront.about.*.
 */

const a = ko.storefront.about;

// Certification images, paired to ko.storefront.about.cert.items in order.
const CERT_IMAGES = [
  "/sales/asset-08.jpg",
  "/sales/asset-09.jpg",
  "/sales/asset-10.jpg",
] as const;

// Partner logos, paired to ko.storefront.about.partners.items in order
// (Toyota, Yale, Komatsu, BYD, HELI, Hangcha).
const PARTNER_IMAGES = [
  "/sales/asset-14.png",
  "/sales/asset-13.png",
  "/sales/asset-15.png",
  "/sales/asset-12.png",
  "/sales/asset-16.png",
  "/sales/asset-11.png",
] as const;

export default function AboutPage() {
  return (
    <main className="flex-1">
      {/* Page hero — dark photo with a left gradient scrim. */}
      <section
        className="relative grid min-h-[62svh] items-end bg-ink bg-cover bg-center pt-[86px] text-white"
        style={{ backgroundImage: "url('/sales/asset-17.jpg')" }}
      >
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-gradient-to-r from-[#050d14]/[0.88] to-[#050d14]/[0.58]"
        />
        <div className="relative mx-auto w-full max-w-[1240px] px-5 pb-[clamp(54px,8vw,96px)] pt-[clamp(80px,12vw,140px)] sm:px-8 lg:px-10">
          <p className="mb-4 text-[13px] font-black uppercase text-signal">
            {a.hero.eyebrow}
          </p>
          <h1 className="m-0 max-w-[820px] text-[clamp(38px,6vw,72px)] font-black leading-[1.08]">
            {a.hero.title}
          </h1>
          <p className="mt-[22px] max-w-[720px] text-[clamp(17px,2vw,22px)] leading-[1.65] text-white/80">
            {a.hero.copy}
          </p>
        </div>
      </section>

      {/* Company — split heading / lead copy panel. */}
      <section className="py-[clamp(74px,10vw,128px)]">
        <div className="mx-auto grid max-w-[1240px] grid-cols-1 items-start gap-10 px-5 sm:px-8 md:grid-cols-[minmax(280px,0.7fr)_1fr] lg:px-10">
          <div>
            <p className="mb-3 text-[13px] font-black uppercase text-brand-teal">
              {a.company.eyebrow}
            </p>
            <h2 className="m-0 text-[clamp(30px,4vw,52px)] font-black leading-[1.15]">
              {a.company.title}
            </h2>
          </div>
          <p className="m-0 text-[17px] leading-[1.65] text-steel">
            {a.company.copy}
          </p>
        </div>
      </section>

      {/* Certification — muted band, 3-up figure grid. */}
      <section className="bg-muted-panel py-[clamp(74px,10vw,128px)]">
        <div className="mx-auto max-w-[1240px] px-5 sm:px-8 lg:px-10">
          <div className="max-w-[780px]">
            <p className="mb-3 text-[13px] font-black uppercase text-brand-teal">
              {a.cert.eyebrow}
            </p>
            <h2 className="m-0 text-[clamp(29px,4vw,52px)] font-black leading-[1.12]">
              {a.cert.title}
            </h2>
          </div>
          <div className="mt-8 grid grid-cols-1 gap-[18px] sm:grid-cols-2 md:grid-cols-3">
            {a.cert.items.map((item, i) => (
              <figure
                key={item.name}
                className="m-0 rounded-lg border border-line bg-white p-6 text-center"
              >
                <img
                  src={CERT_IMAGES[i]}
                  alt={item.imageAlt}
                  className="mx-auto max-h-[320px] object-contain"
                />
                <figcaption className="mt-4 text-lg font-black">
                  {item.name}
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      {/* Partners — brand logo strip. */}
      <section className="bg-[#f6f8fa] py-[clamp(74px,10vw,128px)]">
        <div className="mx-auto max-w-[1240px] px-5 sm:px-8 lg:px-10">
          <div className="max-w-[780px]">
            <p className="mb-3 text-[13px] font-black uppercase text-brand-teal">
              {a.partners.eyebrow}
            </p>
            <h2 className="m-0 text-[clamp(29px,4vw,52px)] font-black leading-[1.12]">
              {a.partners.title}
            </h2>
          </div>
          <ul
            aria-label={a.partners.aria}
            className="mt-7 grid list-none grid-cols-1 gap-[14px] p-0 sm:grid-cols-3 lg:grid-cols-6"
          >
            {a.partners.items.map((partner, i) => (
              <li key={partner.name}>
                <img
                  src={PARTNER_IMAGES[i]}
                  alt={partner.name}
                  className="h-[92px] w-full rounded-lg border border-line bg-white object-contain p-6"
                />
              </li>
            ))}
          </ul>
        </div>
      </section>
    </main>
  );
}
