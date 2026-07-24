# SYNC-MANIFEST — claude.ai/design → local mirror

Source project: `claude.ai/design/p/9c7c313a-2187-4cf1-bb35-7c07ad0a4d9d` (`B2B SaaS Console Design`).

Last sync: **2026-07-24T01:07:46Z** via the first-party Claude Design MCP. Purpose: byte-verified offline continuity of the design authority while preserving declared repo-local fixes.

## Verification result

- `get_project` resolved the requested UUID and URL.
- `list_files(path:"", depth:-1)` supplied the live inventory, sizes, and etags before and after fetching.
- `Oyatie Console.dc.html` was staged with 21 parallel windowed `read_file` calls (1,000 lines each); **every window returned the same etag `1784853611931316`** (no torn read), and the assembled file is **2,179,075 bytes / 20,129 lines** — byte-equal to that etag's live size.
- Every other selected source was fetched whole and `wc -c`-verified against its live byte size at its recorded etag.
- **Upstream was being live-edited during this sync.** After the fetch, the listing already showed newer etags: `Oyatie Console.dc.html` at `1784854600745619` (2,180,329 bytes) and the governing docs moving. `AGENTS.md` and `TODO.md` were therefore refetched once more and settled at `1784854851078112` (verified stable via `if_none_match`). The dc.html mirror is the coherent snapshot at `1784853611931316`; the small trailing delta is the first pick-up item for the next sync.
- Three NEW upstream files imported for the first time: `BENCHMARK.md`, `DEMO.md`, `image-slot.js`.

## Fetched etag record

| file | fetched etag | bytes | local result |
|---|---:|---:|---|
| `AGENTS.md` | `1784854851078112` | 178518 | updated, byte-equal (change-log through **190**) |
| `BENCHMARK.md` | `1784688022213928` | 4288 | NEW — imported, byte-equal |
| `CLAUDE.md` | `1784851391918414` | 8226 | updated, byte-equal |
| `DEMO.md` | `1784688148018911` | 3045 | NEW — imported, byte-equal |
| `DESIGN.md` | `1784851391918414` | 57062 | updated; local typo fix re-applied (byte count unchanged) |
| `HANDOFF.md` | `1783661269027052` | 36418 | unchanged upstream |
| `Oyatie Console.dc.html` | `1784853611931316` | 2179075 | updated, byte-equal at snapshot etag (see live-edit note) |
| `Oyatie Mobile.dc.html` | `1783566865979096` | 829 | unchanged |
| `README.md` | `1783658590972921` | 6900 | unchanged |
| `ROADMAP.md` | `1784854655640519` | 41162 | updated, byte-equal |
| `TODO.md` | `1784854851078112` | 103747 | updated, byte-equal |
| `image-slot.js` | `1784755793573233` | 64449 | NEW — imported, byte-equal |
| `ios-frame.jsx` | `1783566837537010` | 16174 | unchanged |
| `styles.css` | `1783156598994024` | 195 | unchanged |
| `support.js` | `1783070577073224` | 60151 | unchanged |
| `tokens/colors.css` | `1783156611028624` | 1976 | local WCAG fix retained (annotated inline) |
| `tokens/elevation.css` | `1783156624457902` | 399 | unchanged |
| `tokens/spacing.css` | `1783156621546231` | 393 | unchanged |
| `tokens/typography.css` | `1783156618528175` | 1044 | unchanged |

## Local-ahead divergences — do not clobber

- `tokens/colors.css` light `--faint`: upstream `#8b98a7`; local `#5f6d7e`. The local value is the axe-proven WCAG AA repair also carried by `web/src/console/tokens.css`. The tracked copy annotates this inline. The upstream value remains unfixed, so this divergence stays open.
- `DESIGN.md` §4-25 item 7: upstream contains the typo `븠짐없이`; local retains the correct `빠짐없이`. Re-applied on top of upstream etag `1784851391918414`; the files are otherwise byte-equal.

## Known next-sync delta

- `Oyatie Console.dc.html`: live etag `1784854600745619` (2,180,329 bytes) appeared after this snapshot's windowed read completed. Delta ≈ +1,254 bytes (upstream session was still editing). Re-window on the next sync.

## Deliberately not imported

- `.thumbnail`, `screenshots/**`, and `uploads/**`: illustrative or raw-input binaries, not design authority.
- `pii/*.pdf`: binary regulatory references; the existing local copies remain untouched.
- `web/src/**`: snapshots of this repository uploaded to the Design project; this repository's own `web/src/**` remains canonical.
- `AUTOMATION-POLICY-FIDELITY-SPEC.md` and `LEGACY-PARITY-BACKLOG.md`: local-only working documents retained unchanged.
- `.omc/**`: local execution state, never part of the design-authority import.

## Canonical precedence when offline

1. `web/src/**` in this repository — implementation truth.
2. The fresh authority files in this directory, with the two declared local divergences above.
3. The live Design project when an MCP readback is available.
