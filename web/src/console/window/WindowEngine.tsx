// Carbon-copy window/pin engine — renderer (charter §3 P0.2).
//
// Renders ONE active screen's card zone: cards laid out by computeCardLay
// (grid), popouts/pins as position:fixed windows, the docked task tray, and the
// real body padding a pin reserves. Pure presentation over a WindowEngine hook;
// all styling is inline `var(--*)` tokens (no Tailwind/shadcn — purity guard).

import type { CSSProperties } from "react";

import { ko } from "../../i18n/ko";
import { bodyPad, computeCardLay, isHeaderGesture } from "./geometry";
import type { CardRegistry, CardTitles } from "./types";
import { floatKey, lookup } from "./types";
import type { WindowEngine } from "./useWindowEngine";

const t = ko.console.window;

interface Props {
  engine: WindowEngine;
  scr: string;
  registry: CardRegistry;
  titles: CardTitles;
  /** Card body content for `(scr, id)`. */
  renderBody: (scr: string, id: string) => React.ReactNode;
}

const toolBtn: CSSProperties = {
  width: 24,
  height: 24,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--surface)",
  color: "var(--steel)",
  fontSize: "var(--text-sm)",
  cursor: "pointer",
  padding: 0,
};

export function WindowEngine({ engine, scr, registry, titles, renderBody }: Props) {
  const meta = lookup(registry, scr);
  const layout = lookup(engine.state.layout, scr);
  if (!meta || !layout) return null;
  const { state, viewport, hover, chrome } = engine;
  const comp = computeCardLay(meta, layout, state.min, state.float, scr, viewport);
  const pad = bodyPad(state.float, viewport, chrome);
  const titleOf = (id: string) => {
    const m = lookup(titles, scr);
    const v = m ? lookup(m, id) : undefined;
    return typeof v === "string" ? v : id;
  };
  const ids = [...layout.main, ...layout.side];
  const trayCards = state.min.filter((q) => q.scr === scr);

  return (
    <div
      data-window-scr={scr}
      style={{
        position: "relative",
        flex: 1,
        minHeight: 0,
        overflow: "auto",
        background: "var(--canvas)",
        paddingRight: pad.right,
        paddingBottom: pad.bottom + (trayCards.length ? 44 : 0),
      }}
    >
      {/* Positioning track: zone cards are absolute within it; the padding above
          shrinks it so grid cards reflow away from a space-reserving pin. */}
      <div style={{ position: "relative", width: "100%", height: comp.contH }}>
        {ids.map((id) => {
          const key = floatKey(scr, id);
          const fl = lookup(state.float, key);
          const isMin = state.min.some((q) => q.scr === scr && q.id === id);
          if (isMin) return null;
          const box = lookup(comp.cards, id);
          if (!fl && (!box || !box.vis)) return null;

          const style: CSSProperties = fl
            ? {
                position: "fixed",
                left: fl.x,
                top: fl.y,
                width: fl.w,
                height: fl.h,
                zIndex: 80,
                boxShadow: "var(--shadow-pop)",
              }
            : {
                position: "absolute",
                left: box?.x ?? "0px",
                top: box?.y ?? 0,
                width: box?.w ?? "100%",
                height: box?.h ?? 300,
                zIndex: 1,
                boxShadow: "var(--shadow)",
              };

          const showTool = hover?.scr === scr && hover.id === id;
          const pinned = !!fl?.pinned;

          return (
            <section
              key={id}
              data-card-id={id}
              data-card-state={!fl ? "grid" : pinned ? "pin-split" : "popout-float"}
              onMouseEnter={() => {
                engine.setHover({ scr, id });
              }}
              onMouseLeave={() => {
                engine.setHover(null);
              }}
              style={{
                ...style,
                display: "flex",
                flexDirection: "column",
                background: "var(--surface)",
                border: "var(--border-hairline)",
                borderRadius: "var(--radius-card)",
                overflow: "hidden",
              }}
            >
              <header
                data-card-header
                onMouseDown={(e) => {
                  engine.grab(scr, id, e);
                }}
                onDoubleClick={(e) => {
                  const top = e.currentTarget.getBoundingClientRect().top;
                  if (!isHeaderGesture(e.target, e.clientY, top)) return;
                  engine.pinRight(scr, id);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "var(--sp-3)",
                  padding: "var(--sp-3) var(--sp-6)",
                  minHeight: 40,
                  cursor: "grab",
                  borderBottom: "var(--border-hairline)",
                  userSelect: "none",
                }}
              >
                <span
                  style={{
                    fontSize: "var(--text-card-title)",
                    fontWeight: 700,
                    color: "var(--ink)",
                    letterSpacing: "var(--tracking-tight)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {titleOf(id)}
                </span>
                {showTool ? (
                  <div style={{ display: "flex", gap: "var(--sp-1)", flexShrink: 0 }}>
                    <button
                      type="button"
                      aria-label={pinned ? t.unpin : t.pin}
                      title={pinned ? t.unpin : t.pin}
                      onClick={() => {
                        engine.pinRight(scr, id);
                      }}
                      style={{ ...toolBtn, background: pinned ? "var(--muted)" : "var(--surface)" }}
                    >
                      ⊟
                    </button>
                    <button
                      type="button"
                      aria-label={t.minimize}
                      title={t.minimize}
                      onClick={() => {
                        engine.minToggle(scr, id);
                      }}
                      style={toolBtn}
                    >
                      —
                    </button>
                    <button
                      type="button"
                      aria-label={t.close}
                      title={t.close}
                      onClick={() => {
                        engine.restoreDefault(scr, id);
                      }}
                      style={toolBtn}
                    >
                      ✕
                    </button>
                  </div>
                ) : null}
              </header>
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflow: "auto",
                  padding: "var(--sp-5) var(--sp-6)",
                  fontSize: "var(--text-body)",
                  color: "var(--steel)",
                }}
              >
                {renderBody(scr, id)}
              </div>
            </section>
          );
        })}
      </div>

      {/* Docked task tray — minimized cards as restore chips. */}
      {trayCards.length ? (
        <div
          data-window-tray
          aria-label={t.tray}
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            bottom: 0,
            display: "flex",
            alignItems: "center",
            gap: "var(--sp-2)",
            padding: "var(--sp-2) var(--sp-5)",
            background: "var(--surface)",
            borderTop: "var(--border-hairline)",
            zIndex: 90,
          }}
        >
          {trayCards.map((q) => (
            <button
              key={q.id}
              type="button"
              data-tray-chip={q.id}
              aria-label={`${titleOf(q.id)} ${t.restore}`}
              onClick={() => {
                engine.minToggle(q.scr, q.id);
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--sp-1)",
                padding: "var(--sp-1) var(--sp-4)",
                borderRadius: "var(--radius-chip)",
                border: "1px solid var(--border)",
                background: "var(--muted)",
                color: "var(--ink)",
                fontSize: "var(--text-sm)",
                cursor: "pointer",
              }}
            >
              {titleOf(q.id)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
