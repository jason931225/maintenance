import { describe, expect, it } from "vitest";

import { toneBadgeClass, toneTextClass, type Tone } from "./semantic";

const TONES: Tone[] = [
  "danger",
  "warning",
  "success",
  "info",
  "accent",
  "neutral",
];

describe("semantic tone tokens", () => {
  it("exposes stable Tailwind classes for every operational tone", () => {
    for (const tone of TONES) {
      expect(toneBadgeClass(tone)).toBe(
        `border-tone-${tone}-border bg-tone-${tone}-bg text-tone-${tone}-text`,
      );
      expect(toneTextClass(tone)).toBe(`text-tone-${tone}-text`);
    }
  });
});
