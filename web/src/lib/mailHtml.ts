import DOMPurify from "dompurify";
import type { Config } from "dompurify";

const MAIL_HTML_CONFIG: Config = {
  ALLOWED_TAGS: [
    "a",
    "b",
    "blockquote",
    "br",
    "code",
    "div",
    "em",
    "h1",
    "h2",
    "h3",
    "hr",
    "i",
    "li",
    "ol",
    "p",
    "pre",
    "s",
    "span",
    "strong",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "u",
    "ul",
  ],
  ALLOWED_ATTR: ["href", "title", "colspan", "rowspan"],
  ALLOW_DATA_ATTR: false,
  FORBID_ATTR: ["style", "class", "id", "srcset", "onclick", "onerror"],
  FORBID_TAGS: ["form", "iframe", "img", "input", "object", "script", "style", "svg", "video"],
};

function isAllowedHref(raw: string): boolean {
  const value = raw.trim();
  if (value.startsWith("#")) return true;
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  return /^(https?:|mailto:|tel:)/i.test(value);
}

/**
 * Sanitize untrusted inbound mail HTML for browser rendering.
 *
 * The backend deliberately returns `body_html` verbatim so storage remains a
 * faithful mirror of the mailbox. The browser is the rendering boundary: strip
 * active content, remote beacons, inline style, and unsupported URL schemes,
 * then make surviving links explicit new-tab/noopener links.
 */
export function sanitizeMailHtml(html: string): string {
  const clean = DOMPurify.sanitize(html, MAIL_HTML_CONFIG);
  if (typeof document === "undefined") return clean;

  const template = document.createElement("template");
  template.innerHTML = clean;
  for (const link of template.content.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = link.getAttribute("href") ?? "";
    if (!isAllowedHref(href)) {
      link.removeAttribute("href");
      continue;
    }
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  }
  return template.innerHTML;
}
