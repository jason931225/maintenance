# Changelog

## [0.1.62](https://github.com/jason931225/maintenance/compare/v0.1.61...v0.1.62) (2026-07-11)


### Bug Fixes

* **console:** light-mode module surfaces — stop dark background leak ([#470](https://github.com/jason931225/maintenance/issues/470)) ([8882e43](https://github.com/jason931225/maintenance/commit/8882e43b9612c44911fc2eee6b442ffbe7027a3c))

## [0.1.61](https://github.com/jason931225/maintenance/compare/v0.1.60...v0.1.61) (2026-07-11)


### Features

* **console:** round 15 — enum localization, canvas node bodies, inspector formatting ([#468](https://github.com/jason931225/maintenance/issues/468)) ([d704a91](https://github.com/jason931225/maintenance/commit/d704a91a5c782af86a334f0caf195a107e107613))

## [0.1.60](https://github.com/jason931225/maintenance/compare/v0.1.59...v0.1.60) (2026-07-11)


### Features

* **console:** round 11 — global resolver/i18n, dashboard centerpieces, localization, seed depth ([#464](https://github.com/jason931225/maintenance/issues/464)) ([28a939a](https://github.com/jason931225/maintenance/commit/28a939aad3f4ce28d770af506de6d997c8c96aa8))
* **console:** round 12 — table wrap fix, global resolver/i18n, overview density, seed variety ([#465](https://github.com/jason931225/maintenance/issues/465)) ([4f0a083](https://github.com/jason931225/maintenance/commit/4f0a083f60fb505678a801ed4a3d80d76380b0a5))
* **console:** round 13 — rail/identity polish, overview density, clip fixes ([#466](https://github.com/jason931225/maintenance/issues/466)) ([3197b15](https://github.com/jason931225/maintenance/commit/3197b157a76571053136a917c70bbce211cf1136))
* **console:** round 14 — finance structure, rail density, overview agenda, seed depth ([#467](https://github.com/jason931225/maintenance/issues/467)) ([ad4b29a](https://github.com/jason931225/maintenance/commit/ad4b29ae8a111976562a7da183004d646b19e40a))
* **console:** round 3 — mount content planes into the carbon-copy shell (10 screens) ([#458](https://github.com/jason931225/maintenance/issues/458)) ([1e6d80f](https://github.com/jason931225/maintenance/commit/1e6d80f5b7ac638dbe182bf1ebcb4b283523519c))
* **console:** round 4 — data surfacing, blank-body fixes, graph explorer, density/polish ([#459](https://github.com/jason931225/maintenance/issues/459)) ([2e8a05b](https://github.com/jason931225/maintenance/commit/2e8a05bc36d467e22559d790b0d769c8054513f7))
* **console:** round 5 — surface evidence/policy/leave/dashboard, kill UUID/i18n leaks, dense seeds ([#460](https://github.com/jason931225/maintenance/issues/460)) ([990030a](https://github.com/jason931225/maintenance/commit/990030aa46ea058602f3d6dcf473996fa3f964a7))
* **console:** round 6 — dev-auth org scope, leave body, Foundry density ([#461](https://github.com/jason931225/maintenance/issues/461)) ([e8e16b4](https://github.com/jason931225/maintenance/commit/e8e16b410154e24280c59f7b62ab3dc1ca45da9c))
* **console:** round 9 — verdict-driven fixes ([#463](https://github.com/jason931225/maintenance/issues/463)) ([6342037](https://github.com/jason931225/maintenance/commit/634203768beb4556d1728468d596c7814cda3fb4))


### Bug Fixes

* **console:** never-throwing rail time format + rail-scoped error boundary (P0 shell crash) ([#462](https://github.com/jason931225/maintenance/issues/462)) ([f65ae3a](https://github.com/jason931225/maintenance/commit/f65ae3ab88e840c78e77d94656c2dc0a0c396710))
* **evidence:** remove client-fabricated custody state; fail-closed fixity/TSA chips ([#448](https://github.com/jason931225/maintenance/issues/448)) ([286103f](https://github.com/jason931225/maintenance/commit/286103f1b931c32498ea081f64c33998ade6a901))
* **finance-gl:** enforce approver≠preparer SoD on vouchers + verified source provenance ([#451](https://github.com/jason931225/maintenance/issues/451)) ([011abaf](https://github.com/jason931225/maintenance/commit/011abaf6be337c95967db09f142f1dd329d016ed))
* **governance:** bind and consume four-eyes approvals — close the unbound-ref replay bypass ([#456](https://github.com/jason931225/maintenance/issues/456)) ([e3e391a](https://github.com/jason931225/maintenance/commit/e3e391a95e4813795e5d97c2ea4f927414c7c70e))

## [0.1.59](https://github.com/jason931225/maintenance/compare/v0.1.58...v0.1.59) (2026-07-10)


### Features

* **backend:** W1 engine completion — 10 lanes (C-chain, projected dispatch, semantic backfill, seeds, voucher/GL, quant, notifications, payroll, ingest gates) ([#440](https://github.com/jason931225/maintenance/issues/440)) ([d379f5a](https://github.com/jason931225/maintenance/commit/d379f5a08ff138f0adac5567c780fa6a92248d3e))
* **web:** W2 console wave 2 — 10 lanes wired (dynamic grammar, leave/evidence/config/finance, policy bulk gate, dynamics, decisions, compliance, forecast) ([#441](https://github.com/jason931225/maintenance/issues/441)) ([ced3ea3](https://github.com/jason931225/maintenance/commit/ced3ea3e005661923ca2b2625a3ab17a49a5212d))


### Bug Fixes

* **ci:** cancel superseded runs only for PRs — main pushes run to completion ([#438](https://github.com/jason931225/maintenance/issues/438)) ([f097104](https://github.com/jason931225/maintenance/commit/f0971044f07b97e089e15d5ecff0913cc7763b2e))
* **db:** make migration 0112 owner-safe — superuser envs self-apply, prod asserts provisioning ([#444](https://github.com/jason931225/maintenance/issues/444)) ([8644710](https://github.com/jason931225/maintenance/commit/864471028b18e529f545d8367df61b4f88eb29ef))
* **deploy:** resolve mnt-mox PodSecurity rejection — mox cannot run under restricted PSS ([#445](https://github.com/jason931225/maintenance/issues/445)) ([66f0f1a](https://github.com/jason931225/maintenance/commit/66f0f1aca8f253939081a4335d266f17b7852221))

## [0.1.58](https://github.com/jason931225/maintenance/compare/v0.1.57...v0.1.58) (2026-07-10)


### Features

* **web:** console host serves the console at root ([#436](https://github.com/jason931225/maintenance/issues/436)) ([d266837](https://github.com/jason931225/maintenance/commit/d26683793f4986fde73bd6bd9ef99917deeaa127))

## [0.1.57](https://github.com/jason931225/maintenance/compare/v0.1.56...v0.1.57) (2026-07-10)


### Features

* **console:** ontology-first console overhaul M1 — engine spine, wired surfaces, design fidelity ([#432](https://github.com/jason931225/maintenance/issues/432)) ([1c36125](https://github.com/jason931225/maintenance/commit/1c3612523c9206a3f5550fc2bdfc3dd4f2460a6f))


### Bug Fixes

* **db:** restore migration 0036 to its applied byte content (unblocks prod deploy) ([#435](https://github.com/jason931225/maintenance/issues/435)) ([85daac8](https://github.com/jason931225/maintenance/commit/85daac8a8015e0d4aeab64681a32885e37082beb))

## [0.1.56](https://github.com/jason931225/maintenance/compare/v0.1.55...v0.1.56) (2026-07-10)


### Bug Fixes

* **web:** de-flake EmployeesPage vitest teardown race ([#430](https://github.com/jason931225/maintenance/issues/430)) ([312de63](https://github.com/jason931225/maintenance/commit/312de63e6a7fc85725be473b3923d24dd7895c65))

## [0.1.55](https://github.com/jason931225/maintenance/compare/v0.1.54...v0.1.55) (2026-07-10)


### Bug Fixes

* **web:** route first-login onboarding by visible console object ([#428](https://github.com/jason931225/maintenance/issues/428)) ([26833de](https://github.com/jason931225/maintenance/commit/26833de9be0308cefaf543605414a613f636231b))

## [0.1.54](https://github.com/jason931225/maintenance/compare/v0.1.53...v0.1.54) (2026-07-09)


### Features

* **deploy:** add dark production mox stack ([#426](https://github.com/jason931225/maintenance/issues/426)) ([3fd28dc](https://github.com/jason931225/maintenance/commit/3fd28dc5dbb5daf7c7cf6325fbacf2e25c651fc9))
* **messenger:** Slack-parity — channels/DM, presence, ack, reply-quote, per-thread mute ([#261](https://github.com/jason931225/maintenance/issues/261)) ([804268c](https://github.com/jason931225/maintenance/commit/804268cc854e43f4680ba77ac218c42f87f7b1e8))


### Bug Fixes

* **web:** align electronic approval terminology ([#423](https://github.com/jason931225/maintenance/issues/423)) ([9a65619](https://github.com/jason931225/maintenance/commit/9a6561957538f99769de9c251cc68cf3a55d74e4))
* **web:** patch c-ares in runtime image ([#427](https://github.com/jason931225/maintenance/issues/427)) ([c57785b](https://github.com/jason931225/maintenance/commit/c57785b2746f5e7ceb8b646bbe7ecd9f5e32794f))
* **web:** stabilize route-menu CI tests ([#424](https://github.com/jason931225/maintenance/issues/424)) ([a1a281c](https://github.com/jason931225/maintenance/commit/a1a281c2090cc8de81bf7a6ad4229c972351980e))

## [0.1.53](https://github.com/jason931225/maintenance/compare/v0.1.52...v0.1.53) (2026-07-09)


### Features

* **cedar:** enrollment wave 2 — engine decide + resolve shadow, parity report ([#257](https://github.com/jason931225/maintenance/issues/257)) ([8c43215](https://github.com/jason931225/maintenance/commit/8c4321574f7a423be60ec0bb906ba5024b47681c))
* **console-cc:** P0.4 — config-driven generic module template ([#279](https://github.com/jason931225/maintenance/issues/279)) ([b1d2d3a](https://github.com/jason931225/maintenance/commit/b1d2d3ac34c612ec5f446c4a31ae108dad6f77e7))
* **console-cc:** P0.5 — lifecycle card on the real lifecycle engine ([#280](https://github.com/jason931225/maintenance/issues/280)) ([25047ec](https://github.com/jason931225/maintenance/commit/25047ec9ec205bfb1cdc5d5d1c869e1edb35bf3e))
* **console-cc:** P0.6 — 3-layer object card on the object substrate ([#357](https://github.com/jason931225/maintenance/issues/357)) ([684ac15](https://github.com/jason931225/maintenance/commit/684ac15506440a50684450267b023dcb38effdd7))
* **console-cc:** PolicyGated primitive + RUM/CWV budgets ([#269](https://github.com/jason931225/maintenance/issues/269)) ([b3891a7](https://github.com/jason931225/maintenance/commit/b3891a70462a3591d8c19ff7a7127bf1bd6a6693))
* **inbox:** InboxDoc domain — statutory notice vault + passkey receipt confirmation (carbon-copy P1) ([#256](https://github.com/jason931225/maintenance/issues/256)) ([e9b3025](https://github.com/jason931225/maintenance/commit/e9b3025dca16e92ce25d2d45fa912c1b0041766b))
* **leave:** leave-request domain + §61 statutory push (carbon-copy P1) ([#266](https://github.com/jason931225/maintenance/issues/266)) ([52bdd04](https://github.com/jason931225/maintenance/commit/52bdd04f59da9ba613722690d5ddfd4498146f5b))
* **mail:** mox integration slice 1 — dev-stack server, transport adapter, delivery webhooks ([#262](https://github.com/jason931225/maintenance/issues/262)) ([08d7898](https://github.com/jason931225/maintenance/commit/08d78981ebc76835ae554b2a0a223c624c2745d3))
* **objects:** BE-OBJ slice 3 — type registry, SR- series, edge-type registry (ontology depth) ([#258](https://github.com/jason931225/maintenance/issues/258)) ([bd32528](https://github.com/jason931225/maintenance/commit/bd3252893c2cd77d19b2d26e5d8e22191f557b4c))
* **office:** document sessions slice 0 — version domain, JWT embed config, callback pipeline, dev DocumentServer ([#260](https://github.com/jason931225/maintenance/issues/260)) ([25a04b8](https://github.com/jason931225/maintenance/commit/25a04b898594e14d7a83eebe40fe6c4ca31de3c9))
* **workflow:** BE-AUTO slice 2 — object-bound dynamics, branch nodes, four-eyes publish ([#265](https://github.com/jason931225/maintenance/issues/265)) ([979914b](https://github.com/jason931225/maintenance/commit/979914b2cba7ed438579b90bc885b645d2e2ba09))


### Bug Fixes

* **db:** renumber merged migration versions ([#420](https://github.com/jason931225/maintenance/issues/420)) ([27e03e7](https://github.com/jason931225/maintenance/commit/27e03e71bbc9628b768bc459e534727131d978fa))
* **db:** restore unique migration versions after workflow merge ([#422](https://github.com/jason931225/maintenance/issues/422)) ([3bb7a69](https://github.com/jason931225/maintenance/commit/3bb7a69466cae138a5610597b3dbf4a201c33bf9))
* **objects:** link-endpoint visibility gate (B3) + bounded link scans ([#227](https://github.com/jason931225/maintenance/issues/227)) + person.view audit parity (B1) ([#268](https://github.com/jason931225/maintenance/issues/268)) ([33c0e8d](https://github.com/jason931225/maintenance/commit/33c0e8db84b0eb57fbf2ef11440cfabd3df7a4c5))

## [0.1.52](https://github.com/jason931225/maintenance/compare/v0.1.51...v0.1.52) (2026-07-09)


### Features

* **api:** submittable-definitions catalog + global scoped search (carbon-copy P1) ([#254](https://github.com/jason931225/maintenance/issues/254)) ([ab53a5d](https://github.com/jason931225/maintenance/commit/ab53a5d483ec57c5f6b959ba8c2eabb3338a0465))
* **api:** unified action-inbox read model + self punch (carbon-copy P1) ([#255](https://github.com/jason931225/maintenance/issues/255)) ([bdd2750](https://github.com/jason931225/maintenance/commit/bdd2750c9be984828275e8aa0e8390126536168f))
* **ci:** mnt-gate-iac-tier — block cloud-primitive leak into app manifests ([#244](https://github.com/jason931225/maintenance/issues/244)) ([8281c45](https://github.com/jason931225/maintenance/commit/8281c45b3c008cedc31ec59d998108bf46d145eb))
* **console-cc:** P0.2 — carbon-copy window/pin engine ([#248](https://github.com/jason931225/maintenance/issues/248)) ([d8252e3](https://github.com/jason931225/maintenance/commit/d8252e32d6f87c4f1a2612b67d70f863ea57782e))
* **console-cc:** token grammar — @ mentions, # channels, bare-code object links (founder directive) ([#259](https://github.com/jason931225/maintenance/issues/259)) ([41b1686](https://github.com/jason931225/maintenance/commit/41b1686800d721174f0cbe8561c589665dfbef3d))
* **secrets:** stage OpenBao + External-Secrets for portable secrets (dark; retrospectively mapped on 2026-07-13 to ADR-0024 roadmap item 2) ([#267](https://github.com/jason931225/maintenance/issues/267)) ([0d1e374](https://github.com/jason931225/maintenance/commit/0d1e374b4b1ca7f469e9dd6b89cbaa566a1bda1d))


### Bug Fixes

* **audit:** arm org on /api/audit read + stamp org on provisioning/refresh audit rows ([#253](https://github.com/jason931225/maintenance/issues/253)) ([e54a476](https://github.com/jason931225/maintenance/commit/e54a476ca53dc5d20c32438b8d4a8fe426bb9022))
* **comms:** forward-fix mail-sync lease fencing (codex-approved, [#245](https://github.com/jason931225/maintenance/issues/245) merged the pre-fix version) ([#263](https://github.com/jason931225/maintenance/issues/263)) ([be72e22](https://github.com/jason931225/maintenance/commit/be72e224e2b286d91d66d61ad2efd7762f6d1ad5))
* **comms:** make inbound mail-sync HA-safe (worker-gated + SKIP LOCKED lease) ([#245](https://github.com/jason931225/maintenance/issues/245)) ([323085e](https://github.com/jason931225/maintenance/commit/323085e9a601e09966c3f3c70c10c01146bbe716))
* **console:** address P0 scaffold review blockers ([#243](https://github.com/jason931225/maintenance/issues/243)) ([f623ccb](https://github.com/jason931225/maintenance/commit/f623ccb523dc66a8f9306734ca67cc11d67bb46a))
* **db:** renumber 0117_search_trgm_indexes to 0118 (version collision with 0117_comms_email_account_claim_token_fencing) ([f801153](https://github.com/jason931225/maintenance/commit/f801153e8eeeb96588c233302a057a11c354c382))

## [0.1.51](https://github.com/jason931225/maintenance/compare/v0.1.50...v0.1.51) (2026-07-09)


### Bug Fixes

* **identity:** address S0 review coverage ([#238](https://github.com/jason931225/maintenance/issues/238)) ([2920178](https://github.com/jason931225/maintenance/commit/2920178c2e2a3b0d2ba5fd20191be4b32640e69a))
* **objects:** gate account object-resolve on UserManage ([#239](https://github.com/jason931225/maintenance/issues/239)) ([f7401cd](https://github.com/jason931225/maintenance/commit/f7401cd78b609a192fcf2b5c81e788928669287d))

## [0.1.50](https://github.com/jason931225/maintenance/compare/v0.1.49...v0.1.50) (2026-07-09)


### Features

* **console-cc:** P0.0 — console scaffold, verbatim tokens, fidelity-capture rig ([#237](https://github.com/jason931225/maintenance/issues/237)) ([a445334](https://github.com/jason931225/maintenance/commit/a4453342a3b642bc8ae66030699addbf8be46c11))
* **identity:** Identity Console S0 — me/authz projection + identity object kinds ([#234](https://github.com/jason931225/maintenance/issues/234)) ([e66fe1e](https://github.com/jason931225/maintenance/commit/e66fe1ef09cc7979be2d5ea4f0e74c5d0993017a))


### Bug Fixes

* **auth:** deterministic clock for rate-limiter tests (kills CI flake) ([#232](https://github.com/jason931225/maintenance/issues/232)) ([1768d28](https://github.com/jason931225/maintenance/commit/1768d2835c6538913112cbb5b4a8f23ed77b0e13))
* **comms:** route notifications rail through the shared typed client ([#231](https://github.com/jason931225/maintenance/issues/231)) ([b281e80](https://github.com/jason931225/maintenance/commit/b281e80ae57fed2a37ad8854344e585321089a9c))

## [0.1.49](https://github.com/jason931225/maintenance/compare/v0.1.48...v0.1.49) (2026-07-09)


### Features

* **objects:** BE-OBJ slice 2 — code issuance, message refs, graph traversal, route-authority cleanup ([#227](https://github.com/jason931225/maintenance/issues/227)) ([64ceb3f](https://github.com/jason931225/maintenance/commit/64ceb3fc09aec16edde53a8084b2f78524119899))


### Bug Fixes

* **audit-chain:** tighten attestation review fixes ([#228](https://github.com/jason931225/maintenance/issues/228)) ([639e454](https://github.com/jason931225/maintenance/commit/639e45423338b7a9a5c2e98ae266925fac03e729))

## [0.1.48](https://github.com/jason931225/maintenance/compare/v0.1.47...v0.1.48) (2026-07-09)


### Features

* **audit-chain:** attestation endpoint + gap-hardening (PR-2: F2-F5) ([#226](https://github.com/jason931225/maintenance/issues/226)) ([76b7244](https://github.com/jason931225/maintenance/commit/76b7244419087dd710cb68e7415492461b3d8886))
* **console:** UI-M3 — overview unified action inbox + todos domain ([#209](https://github.com/jason931225/maintenance/issues/209)) ([17cca43](https://github.com/jason931225/maintenance/commit/17cca4366b50cf1dfdfde4b07e5ce3da62f19b89))
* **platform:** BE-LC slice 1 — period locks, generic versioning, lifecycle engine MVP ([#211](https://github.com/jason931225/maintenance/issues/211)) ([3a6a6ec](https://github.com/jason931225/maintenance/commit/3a6a6eca9a0047c55aa4b66f8586e4db9fbb4b48))
* **reporting:** audited KPI Excel export (GET /api/v1/exports/kpi) ([#223](https://github.com/jason931225/maintenance/issues/223)) ([7f9bad8](https://github.com/jason931225/maintenance/commit/7f9bad8aa42bf3accbd324585466c80e408caddf))
* **workflow:** BE-WF-HARDEN — run read surface + shared governance-finding helper ([#224](https://github.com/jason931225/maintenance/issues/224)) ([8101a21](https://github.com/jason931225/maintenance/commit/8101a217c544069370b52306d0e890cd723e547e))


### Bug Fixes

* **console:** repair chrome E2E after UI-M2b comms rail (dev-up smoke) ([#215](https://github.com/jason931225/maintenance/issues/215)) ([785299a](https://github.com/jason931225/maintenance/commit/785299a537be3cfd28336bedc9b8ff39a3bf2e73))
* **e2e:** heal main — workflow studio, rail promotion, exec approve (post-merge-train) ([#225](https://github.com/jason931225/maintenance/issues/225)) ([e4be53a](https://github.com/jason931225/maintenance/commit/e4be53a48eecb4fc0a9c8ff83cdfcfb84101e4f1))
* **objects:** resolve enforces domain feature guards for work_order/equipment ([#222](https://github.com/jason931225/maintenance/issues/222)) ([cd2943b](https://github.com/jason931225/maintenance/commit/cd2943bbd8f2b190f65b4e3997204c6eb841e174))
* **workflow:** harden automation trigger follow-ups ([#221](https://github.com/jason931225/maintenance/issues/221)) ([920935e](https://github.com/jason931225/maintenance/commit/920935e9d19c759d61ba9839dfcb4fa35af16d78))

## [0.1.47](https://github.com/jason931225/maintenance/compare/v0.1.46...v0.1.47) (2026-07-09)


### Features

* **workflow:** BE-AUTO slice 1 — event trigger bindings + cron schedules ([#208](https://github.com/jason931225/maintenance/issues/208)) ([7873118](https://github.com/jason931225/maintenance/commit/78731188b05cb7563aa37790d2cb2412c2a7724e))

## [0.1.46](https://github.com/jason931225/maintenance/compare/v0.1.45...v0.1.46) (2026-07-09)


### Features

* **audit-chain:** L20 tamper-evident audit chain — seal worker + verify (PR-1, dark) ([#204](https://github.com/jason931225/maintenance/issues/204)) ([ab63633](https://github.com/jason931225/maintenance/commit/ab63633b69eafc42ac40b744f77e60536ff0fdf3))
* **notifications:** unread-count endpoint for comms rail badge (UI-M2b backend) ([#212](https://github.com/jason931225/maintenance/issues/212)) ([09910af](https://github.com/jason931225/maintenance/commit/09910af60f586917a85c6feb99379da8ddd6e7a5))
* **objects:** BE-OBJ slice 1 — audit per-object filters, object_links edge store, object resolve endpoint ([#206](https://github.com/jason931225/maintenance/issues/206)) ([0008f2f](https://github.com/jason931225/maintenance/commit/0008f2f15eaaf9064003cf8ba0e681d29032989d))


### Bug Fixes

* **workflow:** SoD guard — initiator cannot approve own engine run ([#205](https://github.com/jason931225/maintenance/issues/205)) ([7e45cd0](https://github.com/jason931225/maintenance/commit/7e45cd0215f90029bf8a328e554b72c9a0581ebd))

## [0.1.45](https://github.com/jason931225/maintenance/compare/v0.1.44...v0.1.45) (2026-07-09)


### Features

* add no-code Workflow Studio canvas MVP ([#147](https://github.com/jason931225/maintenance/issues/147)) ([cb1fe6e](https://github.com/jason931225/maintenance/commit/cb1fe6ea06597ba7991216b8876641f26d640bb1))
* **console:** UI-M2a integration — live pin bodies, drag tokens, palette→pin, mention delivery ([#202](https://github.com/jason931225/maintenance/issues/202)) ([53b3261](https://github.com/jason931225/maintenance/commit/53b326179fa4e207ea01daca61b688b8f5cfeb67))


### Bug Fixes

* **authz:** non-normal token mints carry real subject-freshness (Cedar promotion prerequisite) ([#203](https://github.com/jason931225/maintenance/issues/203)) ([e02dd0b](https://github.com/jason931225/maintenance/commit/e02dd0baeed2282d785a36e19805772a12f68c63))
* **e2e:** version-independent storefront visual guard (visibility:hidden) ([#199](https://github.com/jason931225/maintenance/issues/199)) ([a36c0b2](https://github.com/jason931225/maintenance/commit/a36c0b2f1b0bc0125cb133e04bb78c929ca9f4ff))
* **hr:** unlinked accounts read empty self-attendance instead of 403 ([#201](https://github.com/jason931225/maintenance/issues/201)) ([cf67220](https://github.com/jason931225/maintenance/commit/cf67220f46f6bcea5ff36d0fc3363205470badeb))
* **workflow:** Engine-Gen follow-ups — start_policy authoring rule + ?q= submission filter ([#192](https://github.com/jason931225/maintenance/issues/192)) ([e9837ad](https://github.com/jason931225/maintenance/commit/e9837adfb62cc0e2fba9f74c0dae715cb5eb2db6))

## [0.1.44](https://github.com/jason931225/maintenance/compare/v0.1.43...v0.1.44) (2026-07-09)


### Features

* **console:** UI-M1b — ConsoleShell window engine + server-side workspace persistence ([#196](https://github.com/jason931225/maintenance/issues/196)) ([4ad7aa3](https://github.com/jason931225/maintenance/commit/4ad7aa3684f0d28f8d07f7fd7e23459cdc1c5f5c))
* **console:** UI-M2a core — object registry + @/#/! token grammar (standalone modules) ([#194](https://github.com/jason931225/maintenance/issues/194)) ([aff9dc9](https://github.com/jason931225/maintenance/commit/aff9dc92837d542152fe06f77addb17167b1d717))
* **notifications:** notification center backend — outbox drain, REST, realtime fan-out ([#198](https://github.com/jason931225/maintenance/issues/198)) ([8db3d17](https://github.com/jason931225/maintenance/commit/8db3d1770f9754c94977416512c2cbc6fac9a387))

## [0.1.43](https://github.com/jason931225/maintenance/compare/v0.1.42...v0.1.43) (2026-07-08)


### Features

* **cedar:** PBAC activation — role_manage shadow lane (dark, shadow-only) ([#182](https://github.com/jason931225/maintenance/issues/182)) ([950ada8](https://github.com/jason931225/maintenance/commit/950ada8778940bb090469c6baf4d5fa201483ffb))
* **console:** UI-M0 — Oyatie design-system foundation (tokens, icons, primitives, list grammar) ([#184](https://github.com/jason931225/maintenance/issues/184)) ([6970700](https://github.com/jason931225/maintenance/commit/6970700c576bdc4c8c300ac46190d4d62da944ee))
* **console:** UI-M1a — Oyatie shared chrome re-skin (sidebar/topbar/toast) + storefront visual guard ([#186](https://github.com/jason931225/maintenance/issues/186)) ([027c26e](https://github.com/jason931225/maintenance/commit/027c26ed36e9e7ef3a0a866c49236cad87e4adca))
* **relay:** add non-OCI Talos iMessage prep ([#188](https://github.com/jason931225/maintenance/issues/188)) ([76d71ce](https://github.com/jason931225/maintenance/commit/76d71cec13e354c99b5b51a4ff110e32d4e93e2a))
* **workflow:** Engine-Gen — generalized electronic-approval platform (instance REST, 8 templates, finalization/compensation) ([#187](https://github.com/jason931225/maintenance/issues/187)) ([fc67eb2](https://github.com/jason931225/maintenance/commit/fc67eb2b1266dcd87fa6fd14a3b3d1889428ff3f))


### Bug Fixes

* **image:** include embedded docs specs in backend build ([#190](https://github.com/jason931225/maintenance/issues/190)) ([d574432](https://github.com/jason931225/maintenance/commit/d574432e7d9b45dcd5fff4dc3a82e4f3da7f3768))

## [0.1.42](https://github.com/jason931225/maintenance/compare/v0.1.41...v0.1.42) (2026-07-04)


### Features

* **workflow-m2:** workflow runtime engine (dark, codex-approved) ([#179](https://github.com/jason931225/maintenance/issues/179)) ([7a8a5cb](https://github.com/jason931225/maintenance/commit/7a8a5cb4ab974f7a553b0b784d9c92bcb284401e))

## [0.1.41](https://github.com/jason931225/maintenance/compare/v0.1.40...v0.1.41) (2026-07-04)


### Features

* **authz:** add Cedar PBAC baseline ([#171](https://github.com/jason931225/maintenance/issues/171)) ([299a983](https://github.com/jason931225/maintenance/commit/299a98302fcbca16608085f6fdab3ae71172d945))
* **hr:** complete G009 absence→exit→severance-settlement (completes [#166](https://github.com/jason931225/maintenance/issues/166)) ([#170](https://github.com/jason931225/maintenance/issues/170)) ([5989aba](https://github.com/jason931225/maintenance/commit/5989abaa98ca7f65cce9781dbd83800b058350f5))
* **kic:** Korean institutional connectivity coverage factory (fixture-only) ([#173](https://github.com/jason931225/maintenance/issues/173)) ([c68b2b7](https://github.com/jason931225/maintenance/commit/c68b2b7a9ea9f21a573b6ecdcfab2712e7b0c798))


### Bug Fixes

* **auth:** give token refresh its own wider rate bucket for hard navigation ([#178](https://github.com/jason931225/maintenance/issues/178)) ([ea9380b](https://github.com/jason931225/maintenance/commit/ea9380b67d918692a622c2c24c624c607e98ef55))
* **wallboard:** move /wallboard behind the auth guard (security) ([#177](https://github.com/jason931225/maintenance/issues/177)) ([67d831e](https://github.com/jason931225/maintenance/commit/67d831ef6617af7ea0fbd8f737060425b05d79cb))
* **webmail:** degrade read-only mail endpoints to empty state when key absent ([#176](https://github.com/jason931225/maintenance/issues/176)) ([7b62768](https://github.com/jason931225/maintenance/commit/7b627685ace44acdc7c45875746ed728ba025b46))

## [0.1.40](https://github.com/jason931225/maintenance/compare/v0.1.39...v0.1.40) (2026-07-03)


### Features

* **workflow:** add no-code policy template ([#164](https://github.com/jason931225/maintenance/issues/164)) ([80a10bc](https://github.com/jason931225/maintenance/commit/80a10bc2712232ffd94d9f6912274c0277188744))

## [0.1.39](https://github.com/jason931225/maintenance/compare/v0.1.38...v0.1.39) (2026-07-03)


### Bug Fixes

* **ci:** run release-probe on arm64 runner to match arm64-only images ([#162](https://github.com/jason931225/maintenance/issues/162)) ([8061db4](https://github.com/jason931225/maintenance/commit/8061db4e5e5fbb1db82898395150f068f724bcfe))

## [0.1.38](https://github.com/jason931225/maintenance/compare/v0.1.37...v0.1.38) (2026-07-03)


### Features

* **auth:** compile-time dev-auth role-switcher, delete dev-preview fixtures ([#156](https://github.com/jason931225/maintenance/issues/156)) ([87368bb](https://github.com/jason931225/maintenance/commit/87368bb70a006d231175681c4a518f6c0e9d9cf0))

## [0.1.37](https://github.com/jason931225/maintenance/compare/v0.1.36...v0.1.37) (2026-07-03)


### Features

* **dev:** add local full-stack dev-up orchestrator ([#155](https://github.com/jason931225/maintenance/issues/155)) ([6d42736](https://github.com/jason931225/maintenance/commit/6d427367c8f8cef904444ac9575be1ee5c41ee66))


### Bug Fixes

* **docker:** include backend/vendor in mnt-app build context ([#159](https://github.com/jason931225/maintenance/issues/159)) ([8cab093](https://github.com/jason931225/maintenance/commit/8cab0936dc3fab9cb63f9a1501feb8af71fbb513))

## [0.1.36](https://github.com/jason931225/maintenance/compare/v0.1.35...v0.1.36) (2026-07-03)


### Bug Fixes

* **web:** attendance 비고 column + financial-test stabilization ([#154](https://github.com/jason931225/maintenance/issues/154)) ([aa62bff](https://github.com/jason931225/maintenance/commit/aa62bffc38a42ee9f53a1c58fd1fd5f4e7e192da))

## [0.1.35](https://github.com/jason931225/maintenance/compare/v0.1.34...v0.1.35) (2026-07-03)


### Bug Fixes

* **api:** make generated client refreshes atomic ([#145](https://github.com/jason931225/maintenance/issues/145)) ([42dc86f](https://github.com/jason931225/maintenance/commit/42dc86fc6581c6d372d06300e04e47310c15c2de))
* **policy:** hide deferred AI assistant permission ([#146](https://github.com/jason931225/maintenance/issues/146)) ([373241a](https://github.com/jason931225/maintenance/commit/373241adc87f6e856b267ef2d0a22d27673527dc))
* **security:** unblock quick-xml RUSTSEC audit ([#151](https://github.com/jason931225/maintenance/issues/151)) ([9619e4d](https://github.com/jason931225/maintenance/commit/9619e4d7b2377badd1e37f1c961acd2b4295c19e))


### Performance Improvements

* **web:** add tenant-safe SWR read cache ([#149](https://github.com/jason931225/maintenance/issues/149)) ([4b713e5](https://github.com/jason931225/maintenance/commit/4b713e5fdc441be839bde943ae55a4e4acca6f13))

## [0.1.34](https://github.com/jason931225/maintenance/compare/v0.1.33...v0.1.34) (2026-07-02)


### Features

* **hr:** link employee attendance to payroll materials ([#142](https://github.com/jason931225/maintenance/issues/142)) ([c370d17](https://github.com/jason931225/maintenance/commit/c370d179322aca5540c6c3127cf483f1e8341927))

## [0.1.33](https://github.com/jason931225/maintenance/compare/v0.1.32...v0.1.33) (2026-07-02)


### Features

* **hr:** add direct attendance import ([ea400f7](https://github.com/jason931225/maintenance/commit/ea400f7a1d67239262dc47d380ff9c3737381d82))


### Bug Fixes

* **db:** allow lifecycle force-remove cascade ([cc499d4](https://github.com/jason931225/maintenance/commit/cc499d4934ec74e00489848ec7f73b3e758ed756))

## [0.1.32](https://github.com/jason931225/maintenance/compare/v0.1.31...v0.1.32) (2026-07-02)


### Features

* **web:** segment operations navigation ([59d3e82](https://github.com/jason931225/maintenance/commit/59d3e820a118517abd8eead89b4b51dc44da78c8))


### Bug Fixes

* **auth:** refresh stale bearer for QR handoff ([#130](https://github.com/jason931225/maintenance/issues/130)) ([ea1000a](https://github.com/jason931225/maintenance/commit/ea1000a6f3e87a6609da675f8f138485d487a0f2))
* **authz:** restrict org-wide built-in roles ([78d42f4](https://github.com/jason931225/maintenance/commit/78d42f43d5dc4674683142e789adb944c0936e10))
* **web:** unblock granted pending members ([b408208](https://github.com/jason931225/maintenance/commit/b408208fa5f956d4bcbb6282b6a8f376899ba67c))


### Performance Improvements

* **hr:** add tenant-scoped read path indexes ([#129](https://github.com/jason931225/maintenance/issues/129)) ([b246acb](https://github.com/jason931225/maintenance/commit/b246acb7c0581925e27997cd6fd0cfc3ff5d55b3))

## [0.1.31](https://github.com/jason931225/maintenance/compare/v0.1.30...v0.1.31) (2026-07-01)


### Bug Fixes

* **group-admin:** compact subsidiary actions and lso slug ([#128](https://github.com/jason931225/maintenance/issues/128)) ([8ed19e0](https://github.com/jason931225/maintenance/commit/8ed19e0ffe26dd0b7f436425633f5e028c1175cc))

## [0.1.30](https://github.com/jason931225/maintenance/compare/v0.1.29...v0.1.30) (2026-07-01)


### Features

* implement approved operations UI refinements ([c383527](https://github.com/jason931225/maintenance/commit/c383527b16bcc6a8d7acae9b0aa935e4be464612))

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
