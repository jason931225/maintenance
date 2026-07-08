import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { consoleIconNames, consoleIcons } from "./icons";

const expectedIconNames = [
  "overview",
  "inbox",
  "users",
  "userPlus",
  "network",
  "circleCheck",
  "calc",
  "clock",
  "calCheck",
  "heart",
  "receipt",
  "cart",
  "box",
  "layers",
  "truck",
  "wrench",
  "mapPin",
  "checkSq",
  "shieldCheck",
  "fileCheck",
  "folder",
  "history",
  "chart",
  "trend",
  "share",
  "gauge",
  "workflow",
  "repeat",
  "msg",
  "mail",
  "bell",
  "megaphone",
  "book",
  "plus",
  "pen",
  "sun",
  "moon",
  "monitor",
  "mailbox",
  "fingerprint",
  "lock",
  "lockOpen",
  "scroll",
  "gavel",
  "eye",
  "ban",
  "activity",
  "download",
  "alert",
  "pin",
  "minz",
  "close",
] as const;

describe("consoleIcons", () => {
  it("exports the complete Oyatie prototype icon name grammar", () => {
    expect(consoleIconNames).toEqual(expectedIconNames);
    expect(Object.keys(consoleIcons)).toEqual(expectedIconNames);
  });

  it("renders every registered icon as a currentColor 24x24 svg", () => {
    for (const name of consoleIconNames) {
      const Icon = consoleIcons[name];
      const { unmount } = render(
        <Icon aria-label={name} data-testid={`icon-${name}`} />,
      );
      const icon = screen.getByTestId(`icon-${name}`);

      expect(icon.tagName.toLowerCase()).toBe("svg");
      expect(icon).toHaveAttribute("viewBox", "0 0 24 24");
      expect(icon).toHaveAttribute("stroke", "currentColor");

      unmount();
    }
  });
});
