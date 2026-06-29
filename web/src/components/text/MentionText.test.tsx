import { describe, expect, it } from "vitest";

import { splitMentionText } from "./mention-text-parts";

describe("splitMentionText", () => {
  it("detects Korean mentions with punctuation and whitespace boundaries", () => {
    expect(splitMentionText("@이운창 확인, (@정비팀) 공유")).toEqual([
      { kind: "mention", value: "@이운창" },
      { kind: "text", value: " 확인, (" },
      { kind: "mention", value: "@정비팀" },
      { kind: "text", value: ") 공유" },
    ]);
  });

  it("does not treat email addresses as mentions", () => {
    expect(splitMentionText("ops@example.com 에게 메일")).toEqual([
      { kind: "text", value: "ops@example.com 에게 메일" },
    ]);
  });
});
