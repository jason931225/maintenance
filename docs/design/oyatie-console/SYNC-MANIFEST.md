# SYNC-MANIFEST — claude.ai/design → local mirror

Source project: `claude.ai/design/p/9c7c313a-2187-4cf1-bb35-7c07ad0a4d9d` (`B2B SaaS Console Design`).

Last sync: **2026-07-22T00:31:28Z** via the first-party Claude Design MCP. Purpose: byte-verified offline continuity of the design authority while preserving declared repo-local fixes.

## Verification result

- `get_project` resolved the requested UUID and URL.
- `list_files(path:"", depth:-1)` supplied the complete live inventory, sizes, and etags.
- The selected textual sources were staged with windowed `read_file` calls, decoded from the MCP wrapper, and checked against each live UTF-8 byte size before integration.
- Current upstream deltas copied byte-exactly: `AGENTS.md`, `ROADMAP.md`, `TODO.md`, and `Oyatie Console.dc.html`; every other selected source was unchanged at its recorded etag.
- The main console is now current and byte-exact at **1,899,275 bytes / 17,769 lines**; the previous mirror's 256 KiB limitation remains avoided by paging 18 read windows.
- Unchanged sources were fetched and compared byte-for-byte. Two documented local divergences were intentionally retained.

## Live etag record

| file | live etag | live bytes | local result |
|---|---:|---:|---|
| `AGENTS.md` | `1784680173606943` | 118874 | updated, byte-equal |
| `CLAUDE.md` | `1783552476465483` | 7384 | unchanged, byte-equal |
| `DESIGN.md` | `1783659938373543` | 53176 | local typo fix retained |
| `HANDOFF.md` | `1783661269027052` | 36418 | unchanged, byte-equal |
| `Oyatie Console.dc.html` | `1784679904627761` | 1899275 | updated, byte-equal |
| `Oyatie Mobile.dc.html` | `1783566865979096` | 829 | unchanged, byte-equal |
| `README.md` | `1783658590972921` | 6900 | unchanged, byte-equal |
| `ROADMAP.md` | `1784680173606943` | 33646 | updated, byte-equal |
| `TODO.md` | `1784680173606943` | 93983 | updated, byte-equal |
| `ios-frame.jsx` | `1783566837537010` | 16174 | unchanged, byte-equal |
| `styles.css` | `1783156598994024` | 195 | unchanged, byte-equal |
| `support.js` | `1783070577073224` | 60151 | unchanged, byte-equal |
| `tokens/colors.css` | `1783156611028624` | 1976 | local WCAG fix retained |
| `tokens/elevation.css` | `1783156624457902` | 399 | unchanged, byte-equal |
| `tokens/spacing.css` | `1783156621546231` | 393 | unchanged, byte-equal |
| `tokens/typography.css` | `1783156618528175` | 1044 | unchanged, byte-equal |

## Local-ahead divergences — do not clobber

- `tokens/colors.css` light `--faint`: upstream `#8b98a7`; local `#5f6d7e`. The local value is the axe-proven WCAG AA repair also carried by `web/src/console/tokens.css`. The upstream etag remains unchanged, so this divergence stays open.
- `DESIGN.md` §4-25 item 7: upstream contains the typo `븠짐없이`; local retains the correct `빠짐없이`. The files are otherwise byte-equal for this live etag.

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
