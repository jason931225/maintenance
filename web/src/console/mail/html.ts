const ALLOWED_TAGS = new Set([
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
]);

const REMOVED_TAGS = new Set(["form", "iframe", "img", "input", "object", "script", "style", "svg", "video"]);
const ALLOWED_ATTR = new Set(["href", "title", "colspan", "rowspan"]);

export function safeConsoleMailHref(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (value.startsWith("#")) return value;
  if (value.startsWith("/") && !value.startsWith("//")) return value;

  try {
    const base = typeof window === "undefined" ? "https://console.invalid" : window.location.origin;
    const url = new URL(value, base);
    if (url.protocol === "https:" || url.protocol === "mailto:" || url.protocol === "tel:") return url.href;

    const isLocalHttp =
      typeof window !== "undefined" &&
      url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]" ||
        (url.origin === window.location.origin && window.location.protocol === "http:"));
    return isLocalHttp ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function unwrap(element: Element) {
  element.replaceWith(...Array.from(element.childNodes));
}

export function sanitizeConsoleMailHtml(html: string): string {
  if (typeof document === "undefined") return "";
  const template = document.createElement("template");
  template.innerHTML = html;

  const elements = Array.from(template.content.querySelectorAll("*"));
  for (const element of elements.reverse()) {
    const tag = element.tagName.toLowerCase();
    if (REMOVED_TAGS.has(tag)) {
      element.remove();
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) {
      unwrap(element);
      continue;
    }
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || name === "style" || name === "class" || name === "id" || name.startsWith("data-")) {
        element.removeAttribute(attr.name);
        continue;
      }
      if (!ALLOWED_ATTR.has(name)) {
        element.removeAttribute(attr.name);
        continue;
      }
      if (name === "href") {
        const safeHref = safeConsoleMailHref(attr.value);
        if (safeHref) {
          element.setAttribute("href", safeHref);
        } else {
          element.removeAttribute(attr.name);
        }
      }
    }
    if (tag === "a" && element.hasAttribute("href")) {
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noopener noreferrer");
    }
  }
  return template.innerHTML;
}
