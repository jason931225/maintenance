import { describe, expect, it } from "vitest";

import {
  OBJECT_DND_MIME,
  readDraggedObject,
  setDraggedObject,
  tokenForDraggedObject,
} from "./objectDrag";

function fakeTransfer(): DataTransfer {
  const store: Record<string, string> = {};
  return {
    setData: (type: string, value: string) => {
      store[type] = value;
    },
    getData: (type: string) => store[type] ?? "",
    get types() {
      return Object.keys(store);
    },
    effectAllowed: "none",
  } as unknown as DataTransfer;
}

describe("objectDrag", () => {
  it("round-trips an object through the private MIME and mirrors the code to text/plain", () => {
    const transfer = fakeTransfer();
    setDraggedObject(transfer, { kind: "workOrder", code: "WO-1", label: "지게차" });

    expect(transfer.getData("text/plain")).toBe("WO-1");
    expect(readDraggedObject(transfer)).toEqual({ kind: "workOrder", code: "WO-1", label: "지게차" });
    expect(transfer.types).toContain(OBJECT_DND_MIME);
  });

  it("returns null for a transfer with no object payload or a malformed one", () => {
    expect(readDraggedObject(fakeTransfer())).toBeNull();

    const bad = fakeTransfer();
    bad.setData(OBJECT_DND_MIME, "{not json");
    expect(readDraggedObject(bad)).toBeNull();
  });

  it("rejects a payload whose kind is not a real object kind", () => {
    const evil = fakeTransfer();
    evil.setData(OBJECT_DND_MIME, JSON.stringify({ kind: "evil", code: "X-1", label: "x" }));
    expect(readDraggedObject(evil)).toBeNull();
  });

  it("maps a person to an @-mention and any coded object to a !code-link", () => {
    expect(tokenForDraggedObject({ kind: "person", code: "u-1", label: "홍길동" })).toBe("@u-1");
    expect(tokenForDraggedObject({ kind: "workOrder", code: "WO-1", label: "x" })).toBe("!WO-1");
    expect(tokenForDraggedObject({ kind: "support", code: "CS-9", label: "y" })).toBe("!CS-9");
  });
});
