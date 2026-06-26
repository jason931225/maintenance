/**
 * Resolves the link target for the operator-console ("staff login") entry
 * surfaced on the public KNL/COSS storefronts.
 *
 * The marketing sites (knllogistic.com and cosskorea.com / www) and the
 * operator console are one SPA, but in production the console is served from
 * the dedicated `console.` host (the umbrella for FSM + email + governance +
 * asset/finance modules). A staff link on the apex/www site should therefore
 * cross to console.<domain>, while the console host itself, local dev, and
 * preview builds stay same-origin.
 *
 * Resolution order:
 *   1. VITE_CONSOLE_URL — explicit origin override (e.g. a staging console host).
 *   2. apex/www of a known public domain → matching https://console.<domain>.
 *   3. anything else (the console host, localhost, previews) → same-origin (relative).
 *
 * Returns either an absolute `https://console…/login` URL or a same-origin
 * `/login` path; both are valid as an <a href>.
 */
export function consoleHref(
  path = "/login",
  host: string = typeof window === "undefined" ? "" : window.location.host,
): string {
  const override = import.meta.env.VITE_CONSOLE_URL?.trim();
  if (override) {
    return `${override.replace(/\/+$/, "")}${path}`;
  }
  // Matches the public apex and `www.` host, but NOT an existing `console.` (or
  // any other) subdomain — so the console host itself stays same-origin.
  const apex = /^(?:www\.)?(knllogistic\.com|cosskorea\.com)$/i.exec(host);
  if (apex) {
    return `https://console.${apex[1]}${path}`;
  }
  return path;
}
