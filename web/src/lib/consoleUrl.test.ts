import { afterEach, describe, expect, it, vi } from "vitest";

import { consoleHref } from "./consoleUrl";

describe("consoleHref", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("crosses the apex/www to the console host in production", () => {
    expect(consoleHref("/login", "knllogistic.com")).toBe(
      "https://console.knllogistic.com/login",
    );
    expect(consoleHref("/login", "www.knllogistic.com")).toBe(
      "https://console.knllogistic.com/login",
    );
  });

  it("stays same-origin on the console host and in dev/preview", () => {
    expect(consoleHref("/login", "console.knllogistic.com")).toBe("/login");
    expect(consoleHref("/login", "localhost:5173")).toBe("/login");
    expect(consoleHref("/login", "deploy-preview-12.example.com")).toBe("/login");
  });

  it("honors the VITE_CONSOLE_URL override and strips a trailing slash", () => {
    vi.stubEnv("VITE_CONSOLE_URL", "https://console.staging.example.com/");
    expect(consoleHref("/login", "knllogistic.com")).toBe(
      "https://console.staging.example.com/login",
    );
  });

  it("defaults the path to /login", () => {
    expect(consoleHref(undefined, "console.knllogistic.com")).toBe("/login");
  });
});
