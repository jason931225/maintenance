import { describe, expect, it } from "vitest";

import { sanitizeEnvelope } from "./sanitize";
import type { Panel } from "./types";

function validPanel(overrides: Partial<Panel> = {}): unknown {
  return {
    id: "ignored",
    screen: "work-hub",
    area: "right",
    mode: "pinned",
    object: {
      kind: "workOrder",
      code: "WO-1",
      title: "T",
      fields: [{ label: "a", value: "b" }],
    },
    ...overrides,
  };
}

// Envelopes carry the current schema version; the sanitizer rejects anything else.
function wrap(panels: unknown[]): unknown {
  return { v: 1, panels };
}

describe("sanitizeEnvelope", () => {
  it("returns an empty envelope for non-object / missing panels", () => {
    expect(sanitizeEnvelope(null).panels).toEqual([]);
    expect(sanitizeEnvelope({}).panels).toEqual([]);
    expect(sanitizeEnvelope({ v: 1, panels: "nope" }).panels).toEqual([]);
    expect(sanitizeEnvelope(undefined).v).toBe(1);
  });

  it("rejects an unknown/missing schema version", () => {
    expect(sanitizeEnvelope({ panels: [validPanel()] }).panels).toEqual([]);
    expect(sanitizeEnvelope({ v: 2, panels: [validPanel()] }).panels).toEqual(
      [],
    );
  });

  it("keeps a valid panel and recomputes its id from screen + code", () => {
    const env = sanitizeEnvelope(wrap([validPanel()]));
    expect(env.panels).toHaveLength(1);
    expect(env.panels[0].id).toBe("work-hub:workOrder:WO-1");
  });

  it("drops panels with an unknown screen, area, mode, or object kind", () => {
    const env = sanitizeEnvelope(
      wrap([
        validPanel({ screen: "ghost-screen" as never }),
        validPanel({ area: "middle" as never }),
        validPanel({ mode: "floaty" as never }),
        {
          ...(validPanel() as object),
          object: { kind: "spaceship", code: "X", title: "T", fields: [] },
        },
      ]),
    );
    expect(env.panels).toEqual([]);
  });

  it("dedupes panels that resolve to the same screen/kind/code id", () => {
    const env = sanitizeEnvelope(wrap([validPanel(), validPanel()]));
    expect(env.panels).toHaveLength(1);
  });

  it("keeps same-code panels when their object kind differs", () => {
    const env = sanitizeEnvelope(
      wrap([
        validPanel({
          area: "left",
          object: {
            kind: "workOrder",
            code: "DUP-1",
            title: "Work",
            fields: [],
          },
        }),
        validPanel({
          area: "right",
          object: {
            kind: "support",
            code: "DUP-1",
            title: "Support",
            fields: [],
          },
        }),
      ]),
    );
    expect(env.panels.map((panel) => panel.id)).toEqual([
      "work-hub:workOrder:DUP-1",
      "work-hub:support:DUP-1",
    ]);
  });

  it("clamps a float rect's non-finite numbers", () => {
    const env = sanitizeEnvelope(
      wrap([
        validPanel({
          mode: "float",
          float: { x: Number.NaN, y: 40, w: "wide", h: Infinity } as never,
        }),
      ]),
    );
    expect(env.panels[0].float).toEqual({ x: 0, y: 40, w: 468, h: 412 });
  });

  it("clamps finite but impossible float rect values", () => {
    const env = sanitizeEnvelope(
      wrap([
        validPanel({
          mode: "float",
          float: { x: -10, y: -20, w: 0, h: -5 },
        }),
      ]),
    );
    expect(env.panels[0].float).toEqual({ x: 0, y: 0, w: 120, h: 120 });
  });

  it("clamps off-screen float rect positions to the viewport", () => {
    const env = sanitizeEnvelope(
      wrap([
        validPanel({
          mode: "float",
          float: { x: 99_999, y: 99_999, w: 300, h: 200 },
        }),
      ]),
    );
    const viewportWidth =
      typeof window === "undefined" ? 1280 : window.innerWidth;
    const viewportHeight =
      typeof window === "undefined" ? 800 : window.innerHeight;
    expect(env.panels[0].float).toEqual({
      x: Math.max(0, viewportWidth - 300),
      y: Math.max(0, viewportHeight - 200),
      w: 300,
      h: 200,
    });
  });

  it("drops malformed fields but keeps well-formed ones", () => {
    const env = sanitizeEnvelope(
      wrap([
        {
          ...(validPanel() as object),
          object: {
            kind: "workOrder",
            code: "WO-9",
            title: "T",
            fields: [
              { label: "ok", value: "v" },
              { label: 5 },
              "junk",
              { value: "no-label" },
            ],
          },
        },
      ]),
    );
    expect(env.panels[0].object.fields).toEqual([{ label: "ok", value: "v" }]);
  });

  it("caps panels per screen at 8", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      validPanel({
        object: {
          kind: "workOrder",
          code: `WO-${String(i)}`,
          title: "T",
          fields: [],
        },
      }),
    );
    const env = sanitizeEnvelope(wrap(many));
    expect(env.panels).toHaveLength(8);
  });
});
