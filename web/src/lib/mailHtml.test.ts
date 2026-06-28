import { describe, expect, it } from "vitest";

import { sanitizeMailHtml } from "./mailHtml";

function render(html: string): HTMLDivElement {
  const root = document.createElement("div");
  root.innerHTML = sanitizeMailHtml(html);
  return root;
}

describe("sanitizeMailHtml", () => {
  it("strips active content, tracking images, styles, and event handlers", () => {
    const root = render(`
      <style>body{display:none}</style>
      <p class="x" style="color:red" onclick="alert(1)">안전 본문</p>
      <img src="https://tracker.example/pixel" onerror="alert(2)">
      <script>alert(3)</script>
      <form><input name="password"></form>
    `);

    expect(root.textContent).toContain("안전 본문");
    expect(root.querySelector("script, style, form, input, img")).toBeNull();
    expect(root.querySelector("p")?.getAttribute("style")).toBeNull();
    expect(root.querySelector("p")?.getAttribute("onclick")).toBeNull();
    expect(root.querySelector("p")?.getAttribute("class")).toBeNull();
  });

  it("keeps safe links but removes unsupported URL schemes", () => {
    const root = render(`
      <a href="https://www.cossok.com/">공식 링크</a>
      <a href="mailto:sales@example.com">메일</a>
      <a href="//tracker.example/beacon">프로토콜 상대 링크</a>
      <a href="javascript:alert(1)">악성 링크</a>
    `);

    const official = root.querySelector<HTMLAnchorElement>("a[href='https://www.cossok.com/']");
    expect(official).not.toBeNull();
    expect(official).toHaveAttribute("target", "_blank");
    expect(official).toHaveAttribute("rel", "noopener noreferrer");
    expect(root.querySelector("a[href^='//']")).toBeNull();
    expect(root.querySelector("a[href^='javascript:']")).toBeNull();
    expect(root.textContent).toContain("악성 링크");
  });
});
