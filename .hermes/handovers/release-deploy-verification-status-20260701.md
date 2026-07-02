# Release Please / deployment / verification status — 2026-07-01

Kanban: `t_8f52f666` — Release Please and live rollout verification after operations UI batch.

## Current conclusion

Release Please automation is present and working. The latest completed release is `v0.1.29`; the server/web image release for that release succeeded and auto-bumped the production overlay digests. Public endpoints are reachable.

The operations UI batch currently has not produced merged atomic PRs yet, so there is no new release to create for the 1–11 batch. Keep this lane as a release/deploy verification gate that resumes after atomic PRs merge.

## Release Please configuration

- `release-please-config.json`
  - `release-type`: `simple`
  - component: `maintenance`
  - changelog: `CHANGELOG.md`
  - extra version file: `web/package.json` via `$.version`
- `.release-please-manifest.json`: `0.1.29`
- `web/package.json`: `0.1.29`
- latest tag: `v0.1.29`
- latest release: https://github.com/jason931225/maintenance/releases/tag/v0.1.29
- release PRs have been opened/merged automatically in the past, e.g. #125 `chore(main): release 0.1.29`.
- Open Release Please PRs now: none.

## Manual Release Please reconciliation run

Because `origin/main` is currently one commit past `v0.1.29` due to the image-release auto-bump commit, I dispatched Release Please on `main` to verify automation still reconciles current `main`:

- Run: https://github.com/jason931225/maintenance/actions/runs/28484124085
- Event: `workflow_dispatch`
- Head SHA: `ba601de2554709b72bee32a62c7b5fb285cc2b49`
- Conclusion: success
- Open Release Please PR after run: none

Interpretation: there is no currently releasable conventional commit after `v0.1.29`; the only commit since tag is `ba601de deploy(prod): auto-bump mnt-app/mnt-web @a0b9b4e`.

## Latest release/image/deploy evidence

- `v0.1.29` tag target: `a0b9b4e5e22a54f31a0fe2a5368e0025e8511698`
- Release Please run for `v0.1.29`: https://github.com/jason931225/maintenance/actions/runs/28442558555 — success
- Image Release run for `v0.1.29`: https://github.com/jason931225/maintenance/actions/runs/28442558564 — success
  - CI gate: success
  - `mnt-app` build/scan/sign/push: success
  - `mnt-web` build/scan/sign/push: success
  - Auto-bump prod overlay digests: success
- Production overlay bump commit: `ba601de2554709b72bee32a62c7b5fb285cc2b49`
- Overlay digests now:
  - `mnt-app`: `sha256:13856da65f2925c8df5ece5365a6144aa238da94420ccedbe3a25815509188d4`
  - `mnt-web`: `sha256:bfa134fe45d1df68767cad85ad1a84ce1f3550e6f03fdd4402726d8aadb2126c`

## Live/public verification

Curl checks at 2026-07-01 00:07 UTC:

- `https://console.knllogistic.com/healthz` → HTTP 200, body `ok`
- `https://knllogistic.com/healthz` → HTTP 200, body `ok`
- `https://console.knllogistic.com/` → HTTP 200, HTML SHA256 `b73182d34f05c54ce03702aae24a9d44719e6cea913db0f41b8b3e0427dcb4c7`, `Last-Modified: Tue, 30 Jun 2026 12:12:05 GMT`
- `https://console.knllogistic.com/financial` → HTTP 200, same SPA shell hash, login gate visible in browser.

Browser checks:

- `https://console.knllogistic.com/` loads public KNL page successfully.
- `https://console.knllogistic.com/financial` loads console login gate with buttons: passkey login, phone PC login, one-time code, email signup.
- Browser console after `/financial`: 0 console messages / 0 JS errors.

## In-cluster verification blocker

- `argocd` CLI unavailable on this host.
- `kubectl` points at context `k3d-maintenance-relay`, but that cluster does not expose `applications.argoproj.io`; Argo Application state cannot be verified from this machine.
- Public endpoints are healthy, but Argo rollout health must be checked from a host/context with production cluster access.

## Automation caveats / follow-up

- `Release Please` workflow succeeds, but the current workflow run emits a non-blocking annotation: `Unexpected input(s) 'bootstrap-sha'` for `release-please-action@v4`. Automation still works; consider a separate cleanup PR to remove/update the ignored input/comment.
- `gh secret list --repo jason931225/maintenance --app actions` did not show `RELEASE_PLEASE_TOKEN` in this environment. Without that secret, GitHub may suppress tag-triggered downstream workflows created by `GITHUB_TOKEN`; server/web image release is still automated on `main` push and has proven success, but tag-gated mobile release did not show recent runs.
- Do not manually edit release files. After the operations UI atomic PRs merge, let Release Please open/update the release PR, merge it only after checks/review, then verify image release, overlay auto-bump, live health, and browser/user-path E2E.

## Next gate after operations UI PRs merge

1. Check latest `main` SHA and conventional commits since latest tag.
2. Confirm or trigger Release Please workflow on `main`.
3. Review Release Please PR changes only release metadata (`CHANGELOG.md`, manifest, version files).
4. Merge Release Please PR only after approval/green checks.
5. Watch Release Please release/tag and Image Release workflow.
6. Confirm prod overlay auto-bump commit.
7. Verify public health/endpoints and browser UX paths.
8. If production cluster access is available, verify Argo Application sync/health and mnt-app/mnt-web rollout status.
