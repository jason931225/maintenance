# COSS React Native site

Standalone React Native + TypeScript implementation of the COSS public site experience, based on the owned `cossok.com` visual/content baseline and prepared for the migration to `cosskorea.com`.

## Entry points

- `index.js` is the tiny React Native `AppRegistry` shim used by Metro/native hosts.
- `src/App.tsx` renders the TypeScript app.
- `src/CossLandingScreen.tsx` contains the full RN screen, scroll-linked parallax hero, source-video layer, hero/recruit/business controls, language selector, mobile sitemap menu, full-site page selector, page detail surface, and domain migration map.
- `src/cossContent.ts` contains the COSS page content, the source hero MP4 asset path, the source sitemap routes, footer policy routes, and every fetched source route that should move from `cossok.com` to `cosskorea.com`.
- `src/assets/` contains the COSS logo and source imagery captured from the current site.
- `ios/` and `android/` are the React Native 0.86 native app hosts generated from the Community CLI template for local simulator/device runs.

## Local React Native run

Metro:

```bash
npm --workspace @maintenance/coss-rn run start -- --port 8081 --reset-cache
```

iOS simulator, using the repo owner's installed Xcode without changing global `xcode-select`:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  npm --workspace @maintenance/coss-rn run ios -- --no-packager --simulator "iPhone 17"
```

If Xcode is already globally selected, the `DEVELOPER_DIR=...` prefix is optional. For the first iOS install after cloning, run:

```bash
cd coss-rn
bundle install
cd ios
bundle exec pod install
```

Android host files are present under `coss-rn/android`; run with an emulator/device attached:

```bash
npm --workspace @maintenance/coss-rn run android -- --no-packager
```

Desktop browser target, using the same React Native TypeScript app through React Native Web:

```bash
npm --workspace @maintenance/coss-rn run desktop
# open http://127.0.0.1:8082/ at 1440px+ width
```

Production desktop bundle:

```bash
npm --workspace @maintenance/coss-rn run desktop:build
```


## Source sitemap copied

The RN app includes the source public sitemap groups:

- HOME
- COMPANY: `/company`, `/company/vision`, `/company/history`, `/company/affiliates`, `/company/certification`
- BUSINESS: `/business`, `/business/production`, `/business/logistics`, `/business/integrated`, `/business/three_r`, `/business/consulting`, `/business/own-factory`
- SUSTAINABILITY: `/sustainability`, `/sustainability/`, `/sustainability/#net`, `/sustainability/#human`, `/sustainability/#environment`, `/sustainability/#quality`
- CONTACT US: `/contactus`, `/contactus/business-inquiry`, `/contactus/ideal-person`, `/contactus/faq`, `/contactus/report`
- POLICY footer routes discovered from the live crawl: `/policy/terms`, `/policy/privacy`, `/policy/email`, `/policy/sitemap`

## Video, parallax, and motion

- The hero uses `react-native-video` to render the current COSS source MP4 (`/html/_skin/files/coss_main_all_251229.mp4?ver=251224`) behind the same dark scrim and reveal timing as the web reference.
- `Animated.ScrollView` drives a counter-moving `fixed-video-parallax-layer`, matching the source fixed-video/fullpage feel in React Native.
- Hero progress buttons switch the five source slides; recruit and business controls keep the center-card carousel behavior interactive.
- Until the new host serves assets, runtime playback uses the verified legacy file on `www.cossok.com`; `cossHeroVideo.targetUri` records the final `www.cosskorea.com` asset URL for the migration.
- `react-native-video` is autolinked into the native hosts; CocoaPods installed the iOS pod successfully in this workspace.

## Domains

- Public: `www.cosskorea.com`
- Console: `console.cosskorea.com`
- Legacy/source baseline: `cossok.com`

The local implementation uses the `cosskorea.com` targets. DNS/deployment for those hosts must still be configured outside this repository.

## Visual evidence

Latest Visual Ralph artifacts:

- Native iPhone 17 simulator screenshot: `.omx/artifacts/visual-ralph/coss-rn-native/iphone17.png`
- Desktop React Native Web screenshots: `.omx/artifacts/visual-ralph/coss-rn-desktop/desktop-viewport.png` and `.omx/artifacts/visual-ralph/coss-rn-desktop/desktop-parallax-scroll-800.png`
- Source desktop/mobile screenshots: `.omx/artifacts/visual-ralph/coss-refresh-2/`
- React Native visual proxy screenshots: `.omx/artifacts/visual-ralph/coss-rn-preview-v2/desktop-viewport.png`, `mobile-viewport.png`, and `desktop-parallax-scroll-800.png`
- Pixel-diff summary: `.omx/artifacts/visual-ralph/coss-rn-preview-v2/pixel-diff-summary.json`

The preview HTML is only a visual inspection proxy. The implementation is the React Native code and native hosts above.

## Verification

```bash
npm --workspace @maintenance/coss-rn run check:ts
npm --workspace @maintenance/coss-rn test
npm --workspace @maintenance/coss-rn run check:web
npm --workspace @maintenance/coss-rn run desktop:build
curl -fsS http://localhost:8081/status
curl --max-time 45 -fsS 'http://localhost:8081/index.bundle?platform=ios&dev=true&minify=false' -o /tmp/coss-rn-index.bundle
```
