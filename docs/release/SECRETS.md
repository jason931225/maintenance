# Mobile Release Secrets

T1.11 adds a tag-gated mobile release workflow at `.github/workflows/release.yml`.
It uses fastlane `2.236.1`, verified live from RubyGems on 2026-06-12, because the current fastlane docs support App Store Connect API-key auth for TestFlight and Play service-account JSON auth for `supply`.

Uploads are intentionally not faked. On a `v*` tag, the workflow fails before upload with an explicit missing-secret message until the values below are added by the user.

## GitHub Secrets

Add these in GitHub repository settings as Actions secrets.

### Release Please

The `.github/workflows/release-please.yml` workflow opens/updates release PRs on
pushes to `main`.

- Repository Actions setting: keep **Allow GitHub Actions to create and approve
  pull requests** enabled. The workflow-level `contents: write` and
  `pull-requests: write` permissions are not enough when that repo setting is
  disabled.
- Optional `RELEASE_PLEASE_TOKEN`: fine-grained PAT used instead of
  `GITHUB_TOKEN` when automatic downstream tag workflows should chain after
  release-please creates a tag. Grant repository permissions:
  - Contents: Read and write
  - Pull requests: Read and write

Without `RELEASE_PLEASE_TOKEN`, release PR/tag creation can still work through
`GITHUB_TOKEN` after the repo setting above is enabled, but tag-triggered image
and mobile release workflows must be triggered manually because GitHub suppresses
recursive workflow triggers from `GITHUB_TOKEN`.

### Android / Play Internal Track

- `ANDROID_KEYSTORE_BASE64`: base64 of the production Android upload keystore (`.jks` or `.keystore`). Obtain or create this as the Play upload key; keep the original outside the repo.
- `ANDROID_KEYSTORE_PASSWORD`: keystore password.
- `ANDROID_KEY_ALIAS`: upload key alias inside the keystore.
- `ANDROID_KEY_PASSWORD`: upload key password.
- `PLAY_SERVICE_ACCOUNT_JSON`: full JSON key for a Google Play Console service account with access to this app and permission to upload to the internal track. Create it from Play Console API access / Google Cloud service account setup.

Optional:

- `ANDROID_PACKAGE_NAME`: package override. Defaults to `com.maintenance.field`.

### iOS / TestFlight

- `APP_STORE_CONNECT_KEY_ID`: App Store Connect API key ID.
- `APP_STORE_CONNECT_ISSUER_ID`: App Store Connect issuer ID.
- `APP_STORE_CONNECT_KEY_BASE64`: base64 of the downloaded App Store Connect `.p8` API key. Apple only allows downloading the key file once.
- `IOS_APP_IDENTIFIER`: bundle identifier registered in App Store Connect.
- `IOS_SCHEME`: Xcode scheme to archive.
- `IOS_XCODE_PROJECT`: path to the Xcode project, for example `ios/MaintenanceField.xcodeproj`.
- `IOS_XCODE_WORKSPACE`: path to the Xcode workspace if the app uses one. Set this instead of `IOS_XCODE_PROJECT`.
- `IOS_CERTIFICATE_P12_BASE64`: base64 of the Apple Distribution certificate exported as `.p12`.
- `IOS_CERTIFICATE_PASSWORD`: password for the `.p12`.
- `IOS_PROVISIONING_PROFILE_BASE64`: base64 of the App Store distribution provisioning profile.
- `IOS_KEYCHAIN_PASSWORD`: temporary CI keychain password.

Current iOS repo state: `ios/` is a SwiftPM package and does not yet include an `.xcodeproj` or `.xcworkspace`. The dry-run lane builds the Swift package. The TestFlight lane fails clearly until the Xcode packaging layer exists and `IOS_XCODE_PROJECT` or `IOS_XCODE_WORKSPACE` is provided.
The workflow derives `IOS_PROVISIONING_PROFILE_NAME` from the uploaded provisioning profile and passes it to fastlane export options. If you run the `ios release` lane locally, set `IOS_PROVISIONING_PROFILE_NAME` to that profile's `Name` value.

## Local Dry Runs

Install the pinned fastlane bundle:

```sh
bundle install
```

Use Ruby 3.4 or newer locally. The macOS system Ruby is not sufficient for the current pinned fastlane version.

Run dry-run lanes without upload secrets:

```sh
bundle exec fastlane android dry_run
bundle exec fastlane ios dry_run
```

Android release builds remain unsigned unless all four `ANDROID_KEYSTORE_*` environment variables are present. This allows local unsigned release AAB/APK assembly without production signing material.

## Release Tags

Push a tag matching `v*` only after all required secrets are present:

```sh
git tag v0.1.0
git push origin v0.1.0
```

The workflow uploads:

- Android `android/app/build/outputs/bundle/release/app-release.aab` to the Play internal track.
- iOS archive output from the configured Xcode project/workspace to TestFlight.

## Sources Checked

- RubyGems current fastlane versions: https://rubygems.org/gems/fastlane/versions
- fastlane App Store Connect API key auth: https://docs.fastlane.tools/app-store-connect-api/
- fastlane TestFlight upload action: https://docs.fastlane.tools/actions/testflight/
- fastlane Play `supply` service-account JSON auth: https://docs.fastlane.tools/actions/supply/
- GitHub Actions tag trigger syntax: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
