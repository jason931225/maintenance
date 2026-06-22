/**
 * Resolves the link target for the FSM operator-console ("staff login") entry
 * surfaced on the public KNL storefront.
 *
 * The marketing site (knllogistic.com / www) and the operator console are one
 * SPA, but in production the console is served from the dedicated `fsm.` host.
 * A staff link on the apex/www site should therefore cross to fsm.knllogistic.com,
 * while the console host itself, local dev, and preview builds stay same-origin.
 *
 * Resolution order:
 *   1. VITE_CONSOLE_URL — explicit origin override (e.g. a staging console host).
 *   2. apex/www of knllogistic.com → the matching https://fsm.<domain> origin.
 *   3. anything else (the fsm host, localhost, previews) → same-origin (relative).
 *
 * Returns either an absolute `https://fsm…/login` URL or a same-origin `/login`
 * path; both are valid as an <a href>.
 */
export function consoleHref(
  path = "/login",
  host: string = typeof window === "undefined" ? "" : window.location.host,
): string {
  const override = import.meta.env.VITE_CONSOLE_URL?.trim();
  if (override) {
    return `${override.replace(/\/+$/, "")}${path}`;
  }
  // Matches the public apex and `www.` host, but NOT an existing `fsm.` (or any
  // other) subdomain — so the console host itself stays same-origin.
  const apex = /^(?:www\.)?(knllogistic\.com)$/i.exec(host);
  if (apex) {
    return `https://fsm.${apex[1]}${path}`;
  }
  return path;
}
