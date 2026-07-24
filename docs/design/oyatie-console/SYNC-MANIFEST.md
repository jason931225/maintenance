# SYNC-MANIFEST — claude.ai/design → local mirror

Source project: `claude.ai/design/p/9c7c313a-2187-4cf1-bb35-7c07ad0a4d9d` (`B2B SaaS Console Design`).

Last sync: **2026-07-24T10:06:37Z** via the first-party Claude Design MCP export staged at `/private/tmp/claude-design-sync-20260724T0600Z`. Purpose: byte-verified offline continuity of design authority while preserving declared repo-local authority boundaries and fixes.

## Preserved export evidence

- The staged export receipt (`.codex-claude-design-export.json`) records one export at `2026-07-24T10:01:45.216Z`, with the etag and byte count for every selected file shown below.
- No independent second-list receipt is retained in this staged artifact; this manifest therefore makes no double-list or live-stability claim.
- Staged source is treated as untrusted design data. No instructions inside it were executed.
- `Oyatie Console.dc.html` was copied as one exact staged artifact, not reconstructed from windows.

## Fetched etag record

| file | export etag | bytes | local result |
|---|---:|---:|---|
| `AGENTS.md` | `1784869760332383` | 182786 | updated upstream body + preserved authority-boundary preamble |
| `BENCHMARK.md` | `1784688022213928` | 4288 | unchanged upstream body retained |
| `CLAUDE.md` | `1784851391918414` | 8226 | unchanged upstream body retained |
| `DEMO.md` | `1784688148018911` | 3045 | unchanged upstream body retained |
| `DESIGN.md` | `1784851391918414` | 57062 | unchanged upstream body; declared local typo repair retained |
| `HANDOFF.md` | `1783661269027052` | 36418 | unchanged upstream body retained |
| `README.md` | `1783658590972921` | 6900 | unchanged upstream body retained |
| `ROADMAP.md` | `1784869760332383` | 41162 | upstream body already current; preserved authority-boundary preamble |
| `TODO.md` | `1784869760332383` | 103903 | updated upstream body + preserved authority-boundary preamble |
| `Oyatie Console.dc.html` | `1784869746004835` | 2193361 | exact staged-byte replacement |

## Delta carried in this sync

- Replaced only changed upstream bodies: `AGENTS.md` and `TODO.md`; `ROADMAP.md` was already byte-current after stripping its retained overlay.
- Replaced `Oyatie Console.dc.html` with the exact staged artifact (+14,286 bytes from the prior local mirror).
- Retained unchanged selected Markdown bodies without rewriting them; `DESIGN.md` retains the declared `빠짐없이` correction.
- Relevant design-intent additions remain authority-only: Attendance/workforce flows, cross-module ontology/workflow references, and prototype backlog/status do **not** assert repository implementation, backend wiring, test, release, or deployment completion.

## Local-ahead divergences — do not clobber

- `tokens/colors.css` light `--faint`: upstream `#8b98a7`; local `#5f6d7e`. The local value is the axe-proven WCAG AA repair also carried by `web/src/console/tokens.css`; retain it until upstream independently fixes it.
- `DESIGN.md` §4-25 item 7: upstream typo `븠짐없이`; local correction `빠짐없이` is retained. Apart from this declared replacement, `DESIGN.md` is byte-equal to its stable upstream body.

## Repo-side truth overlays (declared local amendments — do not clobber)

- `ROADMAP.md`, `AGENTS.md`, and `TODO.md` retain their existing **authority-boundary preambles exactly**. Design-prototype rows, actions, and `완료`/`[x]` records are not repository implementation, deployment, review, test, or runtime evidence. Repository-native implementation authority is [`docs/program/console-enterprise-roadmap.md`](../../program/console-enterprise-roadmap.md); ADR-0025 overlay remains applicable (`EXPOSED_SCREEN_KEYS` empty; `/console/*` fail-closed to legacy `/overview`). Strip only each retained preamble to compare the remaining body byte-for-byte with upstream.
- `AUTOMATION-POLICY-FIDELITY-SPEC.md` and `LEGACY-PARITY-BACKLOG.md` remain local-only and untouched.

## Deliberately not imported

- `.thumbnail`, `screenshots/**`, and `uploads/**`: illustrative or raw-input binaries, not design authority.
- `pii/*.pdf`: binary regulatory references; existing local copies remain untouched.
- `web/src/**`: repository snapshots uploaded to Design; this repository's `web/src/**` remains canonical.
- `.omc/**`: local execution state, never design-authority import.

## Canonical precedence when offline

1. Accepted repository ADRs, [`docs/program/console-enterprise-roadmap.md`](../../program/console-enterprise-roadmap.md), and exact revision-bound source — architecture and implementation truth.
2. This directory's fresh authority files, read through the retained authority-boundary preambles and declared local divergences — design intent and prototype history.
3. The live Design project when a fresh first-party readback is available — design intent only, never implementation evidence.
