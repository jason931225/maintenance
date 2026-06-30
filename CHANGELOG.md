# Changelog

## [0.1.29](https://github.com/jason931225/maintenance/compare/v0.1.28...v0.1.29) (2026-06-30)


### Features

* **comms:** add standalone mailbox server spine ([#122](https://github.com/jason931225/maintenance/issues/122)) ([61a9503](https://github.com/jason931225/maintenance/commit/61a95036a336f97f3109064c94b8fdf1893b938b))

## [0.1.28](https://github.com/jason931225/maintenance/compare/v0.1.27...v0.1.28) (2026-06-30)


### Bug Fixes

* **db:** preserve applied migration checksum ([#123](https://github.com/jason931225/maintenance/issues/123)) ([d4ea324](https://github.com/jason931225/maintenance/commit/d4ea3247ecd2d634a035f06152c244431673ea6a))

## [0.1.27](https://github.com/jason931225/maintenance/compare/v0.1.26...v0.1.27) (2026-06-30)


### Features

* **financial:** implement purchase request option a ([b8a3088](https://github.com/jason931225/maintenance/commit/b8a3088251910fd5700dc9bd88da5a1e5180b8f6))


### Bug Fixes

* **workflow:** harden runtime trace integrity ([#99](https://github.com/jason931225/maintenance/issues/99)) ([c4e9a26](https://github.com/jason931225/maintenance/commit/c4e9a26bb0cb80eaf5be844915b9523fc72f69bf))

## [0.1.26](https://github.com/jason931225/maintenance/compare/v0.1.25...v0.1.26) (2026-06-30)


### Features

* **workflow:** add runtime persistence spine ([#96](https://github.com/jason931225/maintenance/issues/96)) ([55a9bd3](https://github.com/jason931225/maintenance/commit/55a9bd386b4d6db3ded97058b3b027c3f89aa26f))

## [0.1.25](https://github.com/jason931225/maintenance/compare/v0.1.24...v0.1.25) (2026-06-30)


### Features

* **dispatch:** compact dispatch controls ([6686d21](https://github.com/jason931225/maintenance/commit/6686d217b7d41b618fe7f346baf106ccc4471e9b))


### Bug Fixes

* link platform users to employee records ([d7f7571](https://github.com/jason931225/maintenance/commit/d7f757180cf0c08f4c4c1c93becb62e00fa4d3a6))
* make dispatch board scroll region keyboard accessible ([19cd3e7](https://github.com/jason931225/maintenance/commit/19cd3e7268abd1be204c2a9524c6639ebfcfb486))

## [0.1.24](https://github.com/jason931225/maintenance/compare/v0.1.23...v0.1.24) (2026-06-30)


### Features

* harden platform maturity import and payroll gates ([#89](https://github.com/jason931225/maintenance/issues/89)) ([f6fe80b](https://github.com/jason931225/maintenance/commit/f6fe80b9867298b546e9758f280d6e5e11becdd5))

## [0.1.23](https://github.com/jason931225/maintenance/compare/v0.1.22...v0.1.23) (2026-06-29)


### Features

* complete enterprise operations ultragoal ([#87](https://github.com/jason931225/maintenance/issues/87)) ([d5e9958](https://github.com/jason931225/maintenance/commit/d5e995856163a8fb1f0234bd7eb3074bd764785c))

## [0.1.22](https://github.com/jason931225/maintenance/compare/v0.1.21...v0.1.22) (2026-06-29)


### Bug Fixes

* **release:** trigger release please ([65a5d17](https://github.com/jason931225/maintenance/commit/65a5d17d05ce57a868c2a0f0a85e0122e5d75a69))

## [0.1.21](https://github.com/jason931225/maintenance/compare/v0.1.20...v0.1.21) (2026-06-28)


### Features

* advance enterprise operations backlog ([056d545](https://github.com/jason931225/maintenance/commit/056d54575f4c49d09e5badbd9a512ca34910d8db))

## [0.1.20](https://github.com/jason931225/maintenance/compare/v0.1.19...v0.1.20) (2026-06-28)


### Features

* add enterprise work hub ([#61](https://github.com/jason931225/maintenance/issues/61)) ([a4fdc3c](https://github.com/jason931225/maintenance/commit/a4fdc3c758e87db62a3b1296235f6d9412ee6fcb))

## [0.1.19](https://github.com/jason931225/maintenance/compare/v0.1.18...v0.1.19) (2026-06-27)


### Bug Fixes

* **worker:** prune stale Apalis worker rows ([605e593](https://github.com/jason931225/maintenance/commit/605e5933be8773ac1be7b7c47c621d2e4044b4b8))

## [0.1.18](https://github.com/jason931225/maintenance/compare/v0.1.17...v0.1.18) (2026-06-27)


### Bug Fixes

* **web:** keep GPS settings resilient to malformed timestamps ([#57](https://github.com/jason931225/maintenance/issues/57)) ([0d793b5](https://github.com/jason931225/maintenance/commit/0d793b51db2ef3ad538ca57c6dfd6a59636c31ae))

## [0.1.17](https://github.com/jason931225/maintenance/compare/v0.1.16...v0.1.17) (2026-06-27)


### Bug Fixes

* **worker:** avoid Apalis identity collision during rollout ([d1b1f79](https://github.com/jason931225/maintenance/commit/d1b1f79a674c87aa3873c58d312731f9db35cb96))

## [0.1.16](https://github.com/jason931225/maintenance/compare/v0.1.15...v0.1.16) (2026-06-27)


### Features

* **dispatch:** map arrival events with routing ([3482a0d](https://github.com/jason931225/maintenance/commit/3482a0d25d04583c15a8dbef51da3ae5922ea8d7))

## [0.1.15](https://github.com/jason931225/maintenance/compare/v0.1.14...v0.1.15) (2026-06-26)


### Bug Fixes

* **gitops:** ignore rollout service selectors ([#46](https://github.com/jason931225/maintenance/issues/46)) ([38fcc0f](https://github.com/jason931225/maintenance/commit/38fcc0f3de2db9ed5f8eb7bd6a141803fd208288))
* **gitops:** mark Argo health for hooks and Traefik ingress ([#49](https://github.com/jason931225/maintenance/issues/49)) ([8a4119e](https://github.com/jason931225/maintenance/commit/8a4119ec212c2e7d6b992b57429575eda27c5458))
* **gitops:** persist Argo health customizations ([#48](https://github.com/jason931225/maintenance/issues/48)) ([a9ed02d](https://github.com/jason931225/maintenance/commit/a9ed02d115e4accadad46802eb9292da95c6ac83))

## [0.1.14](https://github.com/jason931225/maintenance/compare/v0.1.13...v0.1.14) (2026-06-26)


### Features

* **auth:** allow group admins to manage subsidiaries ([#45](https://github.com/jason931225/maintenance/issues/45)) ([667fe9a](https://github.com/jason931225/maintenance/commit/667fe9a663d943adae71d03790e8e0c2c4d733c8))
* **platform:** manage group accounts and self passkeys ([#44](https://github.com/jason931225/maintenance/issues/44)) ([d2820ef](https://github.com/jason931225/maintenance/commit/d2820ef90b334addf8e7e171836896021e5b1807))


### Bug Fixes

* **gitops:** clean production drift ([#41](https://github.com/jason931225/maintenance/issues/41)) ([872e3bf](https://github.com/jason931225/maintenance/commit/872e3bf58d5afc0d928f696a2b543ec4a3bc6a2a))
* **gitops:** publish ingress endpoint ([#43](https://github.com/jason931225/maintenance/issues/43)) ([63c6771](https://github.com/jason931225/maintenance/commit/63c6771ec60d0f7176be1ce88fe98b3163eaa883))

## [0.1.13](https://github.com/jason931225/maintenance/compare/v0.1.12...v0.1.13) (2026-06-26)


### Features

* **hr:** add employee workbook import directory ([#39](https://github.com/jason931225/maintenance/issues/39)) ([b51ddfa](https://github.com/jason931225/maintenance/commit/b51ddfab6c8ea735398ab976367231bfb7fadef9))

## [0.1.12](https://github.com/jason931225/maintenance/compare/v0.1.11...v0.1.12) (2026-06-26)


### Features

* **platform:** add tenant management context ([#37](https://github.com/jason931225/maintenance/issues/37)) ([eb03791](https://github.com/jason931225/maintenance/commit/eb03791eca880066c2f8c22fd0fad077902520e9))

## [0.1.11](https://github.com/jason931225/maintenance/compare/v0.1.10...v0.1.11) (2026-06-25)


### Features

* **authz:** add group consolidated read helper ([d640d0e](https://github.com/jason931225/maintenance/commit/d640d0e0275058880ac6cf0aedbee7db2c53534c))

## [0.1.10](https://github.com/jason931225/maintenance/compare/v0.1.9...v0.1.10) (2026-06-25)


### Features

* **authz:** add hierarchy scope JWT claims ([013852d](https://github.com/jason931225/maintenance/commit/013852ddd3c24b633f35c9d010fbdd9e7ec6f786))

## [0.1.9](https://github.com/jason931225/maintenance/compare/v0.1.8...v0.1.9) (2026-06-25)


### Features

* **authz:** add access scope projection ([5a95983](https://github.com/jason931225/maintenance/commit/5a9598309ff20f5b0fc0114f3dadd8f079764473))

## [0.1.8](https://github.com/jason931225/maintenance/compare/v0.1.7...v0.1.8) (2026-06-25)


### Features

* **db:** add org hierarchy group resolvers ([6c7d121](https://github.com/jason931225/maintenance/commit/6c7d121bccffc6b44b43bebb2fdf4bff4bf3bd2c))

## [0.1.7](https://github.com/jason931225/maintenance/compare/v0.1.6...v0.1.7) (2026-06-25)


### Bug Fixes

* **web:** submit intake equipment branch ([4ebcfe2](https://github.com/jason931225/maintenance/commit/4ebcfe20a81c91341e411f518a136174e89723be))

## [0.1.6](https://github.com/jason931225/maintenance/compare/v0.1.5...v0.1.6) (2026-06-25)


### Bug Fixes

* **web:** derive equipment fields from model ([052fe2e](https://github.com/jason931225/maintenance/commit/052fe2e6ef947fc6d642909259d6c88b367645f2))

## [0.1.5](https://github.com/jason931225/maintenance/compare/v0.1.4...v0.1.5) (2026-06-25)


### Bug Fixes

* **web:** suggest reference values in equipment detail edit ([7480954](https://github.com/jason931225/maintenance/commit/7480954c4a5609f130bf8393dd29ed200fd26c4a))

## [0.1.4](https://github.com/jason931225/maintenance/compare/v0.1.3...v0.1.4) (2026-06-25)


### Bug Fixes

* **api:** document 300m default geofence radius ([2a27e43](https://github.com/jason931225/maintenance/commit/2a27e43bb19b1a9d9a4b69b6bfc6af9460fa533e))
* **web:** keep location consent status resilient ([0c5bd67](https://github.com/jason931225/maintenance/commit/0c5bd67012d1098894b0af1661a18e62ac3abcf6))

## [0.1.3](https://github.com/jason931225/maintenance/compare/v0.1.2...v0.1.3) (2026-06-25)


### Bug Fixes

* **deploy:** point Argo apps at main ([c6568ab](https://github.com/jason931225/maintenance/commit/c6568ab7b6781c133610a2159ed7a4a322ef436c))

## [0.1.2](https://github.com/jason931225/maintenance/compare/v0.1.1...v0.1.2) (2026-06-25)


### Bug Fixes

* **test:** accept released semver in footer assertion ([22e9985](https://github.com/jason931225/maintenance/commit/22e99859702e7c476803ae747bdf9db9a89a9f2b))

## [0.1.1](https://github.com/jason931225/maintenance/compare/v0.1.0...v0.1.1) (2026-06-25)


### Features

* add apalis soak gate harness ([55cba5f](https://github.com/jason931225/maintenance/commit/55cba5ff77704492f9ef7016572558a453939261))
* add branch-scoped authz engine ([707f86e](https://github.com/jason931225/maintenance/commit/707f86e1054c161492f7a690076869de65d41cc7))
* add branch-scoped KPI reporting ([6bb6fa2](https://github.com/jason931225/maintenance/commit/6bb6fa23e702d5f96f2396c98b31056de9396e68))
* add CI safety gate binaries ([e06bad0](https://github.com/jason931225/maintenance/commit/e06bad0431f0761d3570afeb606c7ea7140cd23f))
* add compliance location consent store ([8b809c2](https://github.com/jason931225/maintenance/commit/8b809c2c25ad0215a36f5b96d5f1c88161c5e05c))
* add inspection schedules for KPI and daily status ([5311391](https://github.com/jason931225/maintenance/commit/5311391cba722012901a1091bc56bbbdffa84ebe))
* add integration port contracts ([d172854](https://github.com/jason931225/maintenance/commit/d17285461975db7b701a6a95b8898bce80802f23))
* add messenger clients across platforms ([65a89d6](https://github.com/jason931225/maintenance/commit/65a89d644ae818ccd90fc07b237905824d268d09))
* add persisted messenger domain ([792d7f9](https://github.com/jason931225/maintenance/commit/792d7f94140706fb91f3aa026ccce5649ab56554))
* add PITR disaster recovery hardening ([d414f3a](https://github.com/jason931225/maintenance/commit/d414f3a72ad11ffffdd2cbd78bdf5f17f8e03fce))
* add platform auth passkeys and refresh families ([a8dbb0c](https://github.com/jason931225/maintenance/commit/a8dbb0c1cdcab78692b745ec2a169e8c872e88af))
* add platform realtime websocket bridge ([9b8e43e](https://github.com/jason931225/maintenance/commit/9b8e43e7a04fceec58bd5417594c8ca61b284c6b))
* add prod compose stack and mnt-app ([1dbccd3](https://github.com/jason931225/maintenance/commit/1dbccd38a1836395e203ef02a05966d18decabca))
* add registry master-list importer ([9b27df3](https://github.com/jason931225/maintenance/commit/9b27df38cfd69c159cb65671e415fa78d80da976))
* add roster provisioning cold start ([be997f8](https://github.com/jason931225/maintenance/commit/be997f8288043e8a866ec72c150547d7ed9427c4))
* add substitute equipment matching ([6545d2b](https://github.com/jason931225/maintenance/commit/6545d2b4afc9373772992dbd80592f95e91f44ff))
* add web console slice ([51a702e](https://github.com/jason931225/maintenance/commit/51a702e68c97297d4ad66d9e145f6b696be751ab))
* add web KPI dashboard and wallboard ([eef4170](https://github.com/jason931225/maintenance/commit/eef4170a556b7676318e0d80e7b7786791217dfc))
* add workorder domain FSM ([a3c6013](https://github.com/jason931225/maintenance/commit/a3c6013963ac77d1b6e568adaed61d980ff2071e))
* **android:** add technician field app ([27de05b](https://github.com/jason931225/maintenance/commit/27de05b3a984a1acd168705ecaaccbb8194e8512))
* **auth:** move web refresh token to an HttpOnly cookie (dual-transport) ([330b409](https://github.com/jason931225/maintenance/commit/330b409395af891f5d8e8ebc66fb68c947711d4e))
* **auth:** usernameless passkey sign-in + admin-issued one-time OTP sign-in ([e8dfd43](https://github.com/jason931225/maintenance/commit/e8dfd43f6b945862822e3995a975a27962e7e1a3))
* **backend:** Prometheus metrics endpoint backing the SLOs ([44a82e3](https://github.com/jason931225/maintenance/commit/44a82e3ee08819ed5ae23809d468984514c93894))
* **excel:** add daily status template fill engine ([3446561](https://github.com/jason931225/maintenance/commit/34465613b7dd698b0e9790ffccce7786a722e5b3))
* expose passkey auth HTTP routes ([66a2395](https://github.com/jason931225/maintenance/commit/66a2395d635536b7a441a2da8ad424994ddbecbb))
* **p0:** equipment importer+CRUD API, org-management UI, crash-resilient UI + empty states ([720fbaf](https://github.com/jason931225/maintenance/commit/720fbaf3b56e90e2b3c62d341a30bbf8eadb2626))
* **p0:** operability — org setup, equipment importer, crash-resilient UI, security fixes ([84d39e7](https://github.com/jason931225/maintenance/commit/84d39e710204e151465e8c95e7547ba39acfe31d))
* **p0:** org-setup APIs (users/branches/regions + profile) + fix web role nav-gating ([ba78775](https://github.com/jason931225/maintenance/commit/ba7877585521243f657697d12962007a2a7c4136))
* **support:** bound unauthenticated intake field lengths at the edge ([6108c66](https://github.com/jason931225/maintenance/commit/6108c66f82cdef29ade9ae178314d60e172282c9))
* **support:** support-ticket backend domain — internal + customer channels, notifications ([50f920b](https://github.com/jason931225/maintenance/commit/50f920bcb8e98366037830e8c94c25cd8f4befa1))
* **web:** a11y/UX maturity — reduced-motion, dismissible menus ([2ede996](https://github.com/jason931225/maintenance/commit/2ede996a9dbda4bc1d8987ca4356ca6bf763008f))
* **web:** onboarding asks passkey setup method — desktop / mobile / desktop+mobile QR ([b5c3d75](https://github.com/jason931225/maintenance/commit/b5c3d753ae968c49e582861719857ffe0314b099))
* **web:** overhaul console into routed B2B-SaaS app shell (auth page + page-per-module) ([6091263](https://github.com/jason931225/maintenance/commit/6091263943db39705f845925f4b2976b0314fc2e))
* **web:** support ticket console + public customer intake ([cb41556](https://github.com/jason931225/maintenance/commit/cb41556cb3205babae84a6396d9bb773f54a7e39))
* **web:** top-level error boundary ([a460a97](https://github.com/jason931225/maintenance/commit/a460a97472abbe97540b447c7f06dfef772ec02b))
* **web:** usernameless passkey sign-in + one-time OTP first sign-in + onboarding ([6f76146](https://github.com/jason931225/maintenance/commit/6f76146dc0bf43064f9c9bb63e60ec0eba4cdd4e))
* wire web console to read API ([3d01331](https://github.com/jason931225/maintenance/commit/3d013312218a3f67de58268df26cf21a603ffb50))


### Bug Fixes

* **android,db:** repoint Android release to prod TLS + index assignments.mechanic_id ([50797ba](https://github.com/jason931225/maintenance/commit/50797bafb4978dd6256c3ace855a92b64877839b))
* **android:** progress indicators + symptom parity + date-aware timestamps (review MEDIUM) ([0388549](https://github.com/jason931225/maintenance/commit/03885496a130f5df4e96bb864fbf9df0b8abe138))
* **android:** remove unused R.string.symptom (lint UnusedResources) ([11c55b3](https://github.com/jason931225/maintenance/commit/11c55b33e4a26af8ef0618a6954eaba3e55eac8b))
* **auth:** close cold-start OTP + admin-OTP IDOR; add request limits + trusted-proxy IP ([d4781b4](https://github.com/jason931225/maintenance/commit/d4781b4560fac59d63ca31f4c6595f0e150fc30e))
* **auth:** consume the one-time code on passkey registration, not on redeem ([be282e2](https://github.com/jason931225/maintenance/commit/be282e23a2e9f250016da044142c058e8b1f49dc))
* **auth:** re-seed the cold-start OTP when its open credential has expired ([cc7d3dd](https://github.com/jason931225/maintenance/commit/cc7d3dd3abca1abe286c459b9b2bf4c5dc887106))
* **backend:** bound + paginate support, re-resolve scope from DB, query hardening ([5c549f9](https://github.com/jason931225/maintenance/commit/5c549f97d211dcbd792dddad1eb808dfc80e7fbf))
* **backend:** consent per-user + pg_trgm autocomplete + presign limits + hardening (review HIGH/MEDIUM/LOW) ([df40eb1](https://github.com/jason931225/maintenance/commit/df40eb1fc0d836a74413bed1dacea3f37b4a9280))
* **build:** restore direct mnt-app build (unblock image-release) ([528f1c4](https://github.com/jason931225/maintenance/commit/528f1c483517b97ddd8f42e0ac64de3a9baba484))
* **build:** restore direct mnt-app build; drop untested cargo-chef layer ([1a44280](https://github.com/jason931225/maintenance/commit/1a44280dc23aeae50d946dbe4008bd043d7e2e49))
* **ci+deploy:** native arm64 image build + correct domain to knllogistic.com ([6a55b90](https://github.com/jason931225/maintenance/commit/6a55b90c36647f6602fae1bbcaf185fd7582ad87))
* **ci:** compile cargo test against the .sqlx offline cache ([169d371](https://github.com/jason931225/maintenance/commit/169d3715870f56871d99faf8d1ff90e0962e6739))
* **ci:** drain mnt-app stdout in contract harness (real fix for boot 'timeout') ([614f651](https://github.com/jason931225/maintenance/commit/614f6514fa8928711d7c68685faa8f3ef1ecb096))
* **ci:** make OpenAPI drift gate absorb cold cargo compile ([bcc2687](https://github.com/jason931225/maintenance/commit/bcc26878884326b7ce1dfe1743fe1db7689c1a18))
* **ci:** pin Trivy to v0.71.0 via direct release tarball ([0bd54a0](https://github.com/jason931225/maintenance/commit/0bd54a0102b4f0dab72e6eb76bd220a83129f50e))
* **ci:** pre-build mnt-app in the contract harness to kill boot-timeout flake ([14fb516](https://github.com/jason931225/maintenance/commit/14fb5166bb08edce956d9bcb045d2bbf29cc22d7))
* **ci:** reliable contract harness + wire audit ignores ([57a854f](https://github.com/jason931225/maintenance/commit/57a854ffbbf17e0a4a137f596f5f8279d19e0231))
* **ci:** repair broken action pins and cargo-audit gate ([fe6126d](https://github.com/jason931225/maintenance/commit/fe6126d5cbe0aacd60e007dffef050b903e99b08))
* **ci:** resolve mobile string-parity drift and web image openssl CVE ([42c3026](https://github.com/jason931225/maintenance/commit/42c3026a27d128e1f671008f1d2b7c63a31ee7d1))
* **ci:** scan the pushed GHCR image remotely with auth ([68440a3](https://github.com/jason931225/maintenance/commit/68440a345e222501fd9fb2317fd11f6257038443))
* **deploy:** add local-path StorageClass + correct Traefik http-redirect values ([64d2d68](https://github.com/jason931225/maintenance/commit/64d2d689229e1ff1ea4566f3b4bec2cd16b31d39))
* **deploy:** drop unsupported Traefik redirect keys; keep plain :80 for ACME ([ff1fa68](https://github.com/jason931225/maintenance/commit/ff1fa687f8a96c818057feef596de8f7fc8e92e3))
* **deploy:** label Traefik namespace privileged for hostPort under PSS ([3726c13](https://github.com/jason931225/maintenance/commit/3726c13b197cada703c22a2cbb51b710176b1407))
* **deploy:** provision + wire WORM evidence replica bucket ([34cf874](https://github.com/jason931225/maintenance/commit/34cf874462d4fa9b9441d04ca82d6b96eed5bb06))
* **deploy:** wire WORM evidence replica bucket ([5c68e9c](https://github.com/jason931225/maintenance/commit/5c68e9c98183251d2e93c00df46f97f6a82e1cb2))
* **docker:** make the app image build — root context + copy docs/reference & openapi ([79c5f62](https://github.com/jason931225/maintenance/commit/79c5f624a895db82e3f1b2ea27ac2727bd29e02d))
* **harden-2:** close 5 confirmed correctness/concurrency findings ([ea220fd](https://github.com/jason931225/maintenance/commit/ea220fd044fd8b12a366901af6799805d6ec8532))
* **ios:** align passkey login-start with usernameless spec + drift hand-off ([8aff85b](https://github.com/jason931225/maintenance/commit/8aff85b557b620d18700fb05de780a2d89415f58))
* **ios:** camera permission flow + error surfacing + Keychain + parity (review CRITICAL/HIGH/MEDIUM) ([5a32efd](https://github.com/jason931225/maintenance/commit/5a32efd983518f7e1a17364003c0b28fbacdb2cd))
* **ios:** default API base URL to production, not localhost ([bf556ee](https://github.com/jason931225/maintenance/commit/bf556ee01daa8e13ebaf2ebec83bc9ffcafe16a9))
* **ios:** regenerate Swift API client to clear the drift gate ([ae9d005](https://github.com/jason931225/maintenance/commit/ae9d0057afa3f5fbbd3bb208aa1498aa12d2276e))
* **mobile:** finish passkey usernameless alignment + Android refresh-token nullability ([329cf0c](https://github.com/jason931225/maintenance/commit/329cf0ca00c9fab40e435e31df14b5c82d73b672))
* **mobile:** unwrap optional refresh_token (iOS); hold androidx minors needing AGP 9 ([43d70e8](https://github.com/jason931225/maintenance/commit/43d70e8288241ffd000ce00e648fbd26b9e02872))
* renumber dispatch migration 0016-&gt;0017 (collision with reporting exports) ([2d54483](https://github.com/jason931225/maintenance/commit/2d54483c408b8e84e1cf55c3a8ede5f525f6f4ec))
* **reporting:** document+test finding [#6](https://github.com/jason931225/maintenance/issues/6) — nullable branch_id is the rollup case ([8ce00fc](https://github.com/jason931225/maintenance/commit/8ce00fcfc2f49b90a461f1158dd85e676472e73c))
* restore router chain + relocate audit helper (post-T2.4 merge) ([021d34d](https://github.com/jason931225/maintenance/commit/021d34d45310d96d6d499f671b05d9bc1412c2b5))
* **security:** atomic WebAuthn ceremony consume + path-bound audit-coverage exemption ([a30985e](https://github.com/jason931225/maintenance/commit/a30985ec7f4f7bcbb4c815a84f878e98d3829470))
* **security:** bound equipment import upload; tighten user-update branch guard ([4d123b3](https://github.com/jason931225/maintenance/commit/4d123b38282a06e8d87fda8c61d37c155f09b1e9))
* T3.1 merge contract reconciliation — structural spec union ([235ae77](https://github.com/jason931225/maintenance/commit/235ae77f9c47dafd5e40802ae09de3e4a31f86c1))
* **web:** CSP/HSTS, woff2-only fonts, route code-splitting, a11y ([67c41e9](https://github.com/jason931225/maintenance/commit/67c41e9722ac6fcb81c798f75b3c3d4cee680b23))
* **web:** surface write failures + busy states + a11y (review HIGH/MEDIUM/LOW) ([7634781](https://github.com/jason931225/maintenance/commit/7634781a31ed0a7dc7a015f53bd2446ec5600cb8))
* **web:** wire branch/mechanic from the auth session, drop placeholder UUIDs ([003e481](https://github.com/jason931225/maintenance/commit/003e481103af067893e5ac21444bc639b3c2b9c8))
* **worker:** serve /healthz + /readyz so the worker role is probe-able ([c8bafc4](https://github.com/jason931225/maintenance/commit/c8bafc412116e0bd69c0e7268a198a71ccbf6bd8))
