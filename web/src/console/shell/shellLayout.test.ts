import { describe, expect, it } from "vitest";

import { isCommunicationScreen, resolveShellLayout } from "./shellLayout";

describe("resolveShellLayout", () => {
  it.each([
    [1560, { sidebar: 236, rail: 336, compact: false, mobile: false }],
    [1280, { sidebar: 236, rail: 300, compact: false, mobile: false }],
    [1279, { sidebar: 62, rail: 54, compact: true, mobile: false }],
    [768, { sidebar: 62, rail: 54, compact: true, mobile: false }],
  ])("uses the approved chrome at %ipx", (width, expected) => {
    expect(resolveShellLayout(width)).toMatchObject(expected);
  });

  it("switches below 768px to a full-width main with off-canvas widths", () => {
    expect(resolveShellLayout(767)).toEqual({
      sidebar: 244,
      rail: "min(320px, 86vw)",
      compact: true,
      mobile: true,
    });
  });
});

describe("isCommunicationScreen", () => {
  it.each(["messenger", "mail", "notif", "board", "directory"])(
    "removes the rail for the %s full-view route",
    (screen) => {
      expect(isCommunicationScreen(screen)).toBe(true);
    },
  );

  it("keeps the rail for non-communication screens", () => {
    expect(isCommunicationScreen("overview")).toBe(false);
  });
});
