# Changelog

## [0.3.25](https://github.com/oyatie/console/compare/v0.3.24...v0.3.25) (2026-09-10)


### Features

* **buck:** generate the UI member now that Leptos is vendored ([#1080](https://github.com/oyatie/console/issues/1080)) ([aff5cd5](https://github.com/oyatie/console/commit/aff5cd59ed0a40371c1200f7136dc7d7ffba0010))
* **contracts:** generate 13 action Inputs and 6 Heads from one manifest ([#998](https://github.com/oyatie/console/issues/998)) ([68e533c](https://github.com/oyatie/console/commit/68e533c676871dfd6e090f211929bf1e8c1973a0))
* **contracts:** generate 13 typed execute codecs from the semantic manifest ([#999](https://github.com/oyatie/console/issues/999)) ([950e141](https://github.com/oyatie/console/commit/950e14183827d66766fc8dbe5aaa74113023281d))
* **contracts:** generate a TypeScript SDK from composed OpenAPI ([#1001](https://github.com/oyatie/console/issues/1001)) ([cbffcb0](https://github.com/oyatie/console/commit/cbffcb00f20ca306d2a5a3c287e33e8ce09ddedf))
* **contracts:** generate API docs from composed OpenAPI ([#1004](https://github.com/oyatie/console/issues/1004)) ([fe8cff8](https://github.com/oyatie/console/commit/fe8cff8e3f91773baf4555f953fc0e0ea76cd307))
* **contracts:** generate bind_canonical_action_params from the manifest ([#1002](https://github.com/oyatie/console/issues/1002)) ([71cde74](https://github.com/oyatie/console/commit/71cde745d2984112711e6c9f8fcf4f7f3a711ad9))
* **contracts:** generate Head and Input property shapes from DTO types ([#1000](https://github.com/oyatie/console/issues/1000)) ([96048e9](https://github.com/oyatie/console/commit/96048e959ce0c324b98433988c6e73d0c8aa8a83))
* **contracts:** generate objects/links/actions from the DTO roster ([#1003](https://github.com/oyatie/console/issues/1003)) ([752c1ab](https://github.com/oyatie/console/commit/752c1abd9b03557ad899f6e340075152a9efd00b))
* **contracts:** publish Head concurrency from DTO version ([#1006](https://github.com/oyatie/console/issues/1006)) ([ee660ca](https://github.com/oyatie/console/commit/ee660cab77511ad10348989df25ccd62199ba010))
* **docs:** generate composed link operationIds and permissions ([#1018](https://github.com/oyatie/console/issues/1018)) ([f66acd4](https://github.com/oyatie/console/commit/f66acd4522ac01292314a4ab206dc1bed7862afa))
* **governance:** deny unknown fields on configure-transition body ([#1045](https://github.com/oyatie/console/issues/1045)) ([1ddc525](https://github.com/oyatie/console/commit/1ddc5254fea620325853cb2ae33b211427f3b63e))
* **governance:** deny unknown fields on decide-approval body ([#1047](https://github.com/oyatie/console/issues/1047)) ([8eba894](https://github.com/oyatie/console/commit/8eba8949fae2f7fb1847b87e2869615c1be756eb))
* **governance:** deny unknown fields on lifecycle preflight body ([#1046](https://github.com/oyatie/console/issues/1046)) ([025a176](https://github.com/oyatie/console/commit/025a1762267c3fc1e2cf5482e152a3dd8a965a12))
* **governance:** deny unknown fields on lifecycle-hold body ([#1053](https://github.com/oyatie/console/issues/1053)) ([3a346fb](https://github.com/oyatie/console/commit/3a346fbcc6946deb4a6650e0d26ec670d19ffcb3))
* **governance:** deny unknown fields on lifecycle-transition body ([#1054](https://github.com/oyatie/console/issues/1054)) ([06d52de](https://github.com/oyatie/console/commit/06d52de22ced4f85b1b583d71493515ae1db460d))
* **hr:** deny unknown fields on attendance-record body ([#1049](https://github.com/oyatie/console/issues/1049)) ([b2a9611](https://github.com/oyatie/console/commit/b2a9611757a06112073f9d70ebfe5eb50f1c8500))
* **hr:** deny unknown fields on confirm-exit-case body ([#1052](https://github.com/oyatie/console/issues/1052)) ([2e68851](https://github.com/oyatie/console/commit/2e68851022a006c51db85bf1c93ae920bb2d445b))
* **hr:** deny unknown fields on draft-exit-approval body ([#1051](https://github.com/oyatie/console/issues/1051)) ([ef4bf4d](https://github.com/oyatie/console/commit/ef4bf4d0e31dd358d2e721ae5f065ed07f380b07))
* **hr:** deny unknown fields on lifecycle-event body ([#1050](https://github.com/oyatie/console/issues/1050)) ([67d4c45](https://github.com/oyatie/console/commit/67d4c45ef7f6caeafa169a41a92e9d60418546cf))
* **hr:** deny unknown fields on report-exit-case body ([#1048](https://github.com/oyatie/console/issues/1048)) ([ca2f89f](https://github.com/oyatie/console/commit/ca2f89fb12e4851490732029df3441f21b154fed))
* **hr:** Employment collection from/to using as_of algebra ([#1005](https://github.com/oyatie/console/issues/1005)) ([7952473](https://github.com/oyatie/console/commit/7952473e349ea26773841d4ef33cc1c3bb22e241))
* **hr:** publish JobPosition Head instance and collection GETs ([#1014](https://github.com/oyatie/console/issues/1014)) ([b43e008](https://github.com/oyatie/console/commit/b43e0086ac15f90c73a83c5ee82ed083919ca00e))
* **hr:** publish OrgUnit, Company, and Person Head collection GETs ([#1009](https://github.com/oyatie/console/issues/1009)) ([4ea5372](https://github.com/oyatie/console/commit/4ea537292699b54f46607e5b18c2fe04253df876))
* **hr:** publish OrgUnit, Company, and Person Head instance GETs ([#1008](https://github.com/oyatie/console/issues/1008)) ([d3ab190](https://github.com/oyatie/console/commit/d3ab1909eb46e742aa40cd88f2d1d4ee040d4796))
* **hr:** publish OrgUnit→JobPosition reverse collection GET ([#1016](https://github.com/oyatie/console/issues/1016)) ([9a1d135](https://github.com/oyatie/console/commit/9a1d135d711b9feb4cb06a0c089d616fae8a4385))
* **hr:** serialize employment_revisions.version on Employment Head ([#1007](https://github.com/oyatie/console/issues/1007)) ([e0c7bba](https://github.com/oyatie/console/commit/e0c7bba0b2674a26942f447c2e13de7f50dc640f))
* **identity:** deny unknown fields on create user body ([#1069](https://github.com/oyatie/console/issues/1069)) ([7d05b9f](https://github.com/oyatie/console/commit/7d05b9f04ee7493a81c03a35715d33129604bd00))
* **identity:** deny unknown fields on update self body ([#1071](https://github.com/oyatie/console/issues/1071)) ([f44add9](https://github.com/oyatie/console/commit/f44add94de82d3901a0b64a2fcc81634da4ef6b0))
* **identity:** deny unknown fields on update user body ([#1070](https://github.com/oyatie/console/issues/1070)) ([cb9f969](https://github.com/oyatie/console/commit/cb9f969398823987ce2252d47a86df4c83ed20be))
* **notices:** deny unknown fields on create draft body ([#1067](https://github.com/oyatie/console/issues/1067)) ([d4a9f9e](https://github.com/oyatie/console/commit/d4a9f9e83b0d6862a52a7f1c98d4cca8c5784d98))
* **notices:** deny unknown fields on update draft body ([#1068](https://github.com/oyatie/console/issues/1068)) ([b91e5e8](https://github.com/oyatie/console/commit/b91e5e829d743e41467966fcb7a1f468f5f04bd7))
* **ontology:** deny unknown fields on instance lifecycle body ([#1043](https://github.com/oyatie/console/issues/1043)) ([34cd747](https://github.com/oyatie/console/commit/34cd7472622003c486d1b2ace3365d9161adc3e6))
* **ontology:** deny unknown fields on object-link create body ([#1055](https://github.com/oyatie/console/issues/1055)) ([cc4e6aa](https://github.com/oyatie/console/commit/cc4e6aaaf5ca994de9581bea26750a5748b8cb26))
* **ontology:** deny unknown fields on object-policy attach body ([#1044](https://github.com/oyatie/console/issues/1044)) ([6b96c69](https://github.com/oyatie/console/commit/6b96c69f04dab13ecca747ae4ab8693c08add194))
* **ontology:** deny unknown fields on object-type lifecycle body ([#1042](https://github.com/oyatie/console/issues/1042)) ([45e8aa6](https://github.com/oyatie/console/commit/45e8aa6e81b38edf624f08bb973ade512e8954dc))
* **openapi:** bind GateChainOutcome.gates[] items to existing GateOutcome ([#1039](https://github.com/oyatie/console/issues/1039)) ([76a213a](https://github.com/oyatie/console/commit/76a213ae6d9b399091f13f2d75fe5c9cb13fb016))
* **openapi:** bind GET /api/audit 200 items to existing AuditRecord ([#1022](https://github.com/oyatie/console/issues/1022)) ([78115ae](https://github.com/oyatie/console/commit/78115ae0e797b7880e8ec5c750fb02a4528e245a))
* **openapi:** bind GET /api/v1/group-admin/groups to existing GroupAdminGroupsResponse ([#1026](https://github.com/oyatie/console/issues/1026)) ([84bccee](https://github.com/oyatie/console/commit/84bccee286346fd069113b73fbd90ad99cde7ea3))
* **openapi:** bind GET /api/v1/hr/readiness-summary to existing HrReadinessSummary ([#1024](https://github.com/oyatie/console/issues/1024)) ([39e8adb](https://github.com/oyatie/console/commit/39e8adbd5c743ad8e0fbfcc83e8fa1287955476a))
* **openapi:** bind GET /api/v1/policy/catalog to existing CatalogEntry ([#1025](https://github.com/oyatie/console/issues/1025)) ([f288add](https://github.com/oyatie/console/commit/f288adde956c7a7409507a59883581a1c78dd18f))
* **openapi:** bind GET absence-exit-dashboard to existing AbsenceExitDashboardResponse ([#1036](https://github.com/oyatie/console/issues/1036)) ([fe4ff29](https://github.com/oyatie/console/commit/fe4ff2962b7561a366dcb12fd0cab0e268a27280))
* **openapi:** bind GET object-types/{key} to existing ObjectTypeDetail ([#1037](https://github.com/oyatie/console/issues/1037)) ([938da68](https://github.com/oyatie/console/commit/938da6875fed4c543a7cdeec226333152a28ddd8))
* **openapi:** bind Head FK links to published GET operations ([#1013](https://github.com/oyatie/console/issues/1013)) ([73981aa](https://github.com/oyatie/console/commit/73981aa22df0ba0e5c979ba5d2d5524e49eb4018))
* **openapi:** bind HR exit-case 201/200 to existing EmployeeExitCaseResponse ([#1035](https://github.com/oyatie/console/issues/1035)) ([81f856a](https://github.com/oyatie/console/commit/81f856ae7ddad6ff981d8b9168908b9b52c18eba))
* **openapi:** bind listObjectTypes 200 items to existing ObjectTypeSummary ([#1023](https://github.com/oyatie/console/issues/1023)) ([5ff8d92](https://github.com/oyatie/console/commit/5ff8d920e3897d40a3305ed8d901cb47b162dea3))
* **openapi:** bind ontology instance GET/history to existing schemas ([#1020](https://github.com/oyatie/console/issues/1020)) ([6922c5e](https://github.com/oyatie/console/commit/6922c5ea414e7506c72d5a7adb5f086ee9d93c5d))
* **openapi:** bind policy drafts 200/201 to existing DraftRecord ([#1034](https://github.com/oyatie/console/issues/1034)) ([becee86](https://github.com/oyatie/console/commit/becee860872e6d76a5f04effe737ac3f9038aaf8))
* **openapi:** bind PolicyNoCodeCondition.value to existing ConditionValue ([#1040](https://github.com/oyatie/console/issues/1040)) ([f508811](https://github.com/oyatie/console/commit/f50881151f828011a549907411f43f93a4808e5a))
* **openapi:** bind POST governance approvals decide 201 to existing ApprovalSummary ([#1031](https://github.com/oyatie/console/issues/1031)) ([77b8069](https://github.com/oyatie/console/commit/77b80695497d41c588dfcd9335be9bba96ef201e))
* **openapi:** bind POST governance lifecycle preflight 200 to existing LifecyclePreflight ([#1029](https://github.com/oyatie/console/issues/1029)) ([52ab2b7](https://github.com/oyatie/console/commit/52ab2b7ab021158b58e3f6aaaadaaba79d47587a))
* **openapi:** bind POST governance lifecycle transitions 201 to existing LifecycleTransitionConfig ([#1032](https://github.com/oyatie/console/issues/1032)) ([fc49387](https://github.com/oyatie/console/commit/fc493874df47eb0023c94277fcd2a212619c646b))
* **openapi:** bind POST governance overrides 201 to existing OverrideSummary ([#1033](https://github.com/oyatie/console/issues/1033)) ([8af96b5](https://github.com/oyatie/console/commit/8af96b5889880dd6da08acb5e6eed7cc06dd1b52))
* **openapi:** bind POST group-admin tenant-context 200 to existing GroupAdminTenantContextStartResponse ([#1030](https://github.com/oyatie/console/issues/1030)) ([5d63727](https://github.com/oyatie/console/commit/5d6372781dae8a59462bded5d848a5450cd748ca))
* **openapi:** bind POST ontology action preflight 200 to existing PreflightOutcome ([#1027](https://github.com/oyatie/console/issues/1027)) ([6ed8c47](https://github.com/oyatie/console/commit/6ed8c471bb1864cca563b0ac6ce61a90a72aac9f))
* **openapi:** bind POST policy authorize/simulate 200 to existing DecisionResponse ([#1028](https://github.com/oyatie/console/issues/1028)) ([3756d6a](https://github.com/oyatie/console/commit/3756d6a78091e635ba3f0b0cb96184dee7e8ea28))
* **openapi:** emit composed path schemas in generated SDK and docs ([#1041](https://github.com/oyatie/console/issues/1041)) ([4ed58b0](https://github.com/oyatie/console/commit/4ed58b061bb3eec35762ffe40b4b9b67b99a3db7))
* **openapi:** generate Head GET/list permissions from EmployeeDirectoryRead ([#1017](https://github.com/oyatie/console/issues/1017)) ([858eb64](https://github.com/oyatie/console/commit/858eb6428279df42511ed5a46dbb74bce7b8f87d))
* **openapi:** publish existing GET /api/audit target_id and trace_id filters ([#1021](https://github.com/oyatie/console/issues/1021)) ([3e54772](https://github.com/oyatie/console/commit/3e54772da62303468a621f8efc559a2e0a323964))
* **openapi:** stamp composed info.version from crate version ([#1015](https://github.com/oyatie/console/issues/1015)) ([a9e0a8c](https://github.com/oyatie/console/commit/a9e0a8cb1aa496254febd260d5d30b5568084e13))
* **openapi:** type ontology action execute 200 non-Value fields ([#1038](https://github.com/oyatie/console/issues/1038)) ([e23eb75](https://github.com/oyatie/console/commit/e23eb75df1df54a4d18e6147588e424f9b206305))
* **policy:** deny unknown fields on create policy role body ([#1062](https://github.com/oyatie/console/issues/1062)) ([0b7739b](https://github.com/oyatie/console/commit/0b7739ba585527d7523f2d9523ebdcbc4ee43025))
* **policy:** deny unknown fields on policy authorize body ([#1059](https://github.com/oyatie/console/issues/1059)) ([8baa9eb](https://github.com/oyatie/console/commit/8baa9eb9da53792d563a78637cd52ef1084a7ee5))
* **policy:** deny unknown fields on policy bulk-authorize body ([#1061](https://github.com/oyatie/console/issues/1061)) ([df6c352](https://github.com/oyatie/console/commit/df6c3522fd4d38c57e1c8abcf2d77eb11a39d2da))
* **policy:** deny unknown fields on policy role status-preview body ([#1065](https://github.com/oyatie/console/issues/1065)) ([3616dd8](https://github.com/oyatie/console/commit/3616dd8da5c9b85ff144ba3a42f13f21be257e21))
* **policy:** deny unknown fields on policy simulate body ([#1060](https://github.com/oyatie/console/issues/1060)) ([a47a62a](https://github.com/oyatie/console/commit/a47a62ab38ad07167fdee36a734b759486cf67ce))
* **policy:** deny unknown fields on policy-draft create body ([#1056](https://github.com/oyatie/console/issues/1056)) ([ac54b9d](https://github.com/oyatie/console/commit/ac54b9d7783c7ee2cb946fa38b363a94e75307af))
* **policy:** deny unknown fields on policy-draft review body ([#1058](https://github.com/oyatie/console/issues/1058)) ([5495d70](https://github.com/oyatie/console/commit/5495d70f9fd1e8b8760a14319494ee65f0356c00))
* **policy:** deny unknown fields on policy-draft update body ([#1057](https://github.com/oyatie/console/issues/1057)) ([474b980](https://github.com/oyatie/console/commit/474b980950b2e16cc41c8df0de3e5b0bc101c95f))
* **policy:** deny unknown fields on replace policy role assignments body ([#1066](https://github.com/oyatie/console/issues/1066)) ([d68543f](https://github.com/oyatie/console/commit/d68543f1aebaaaea7baf4e12d249bfc7ef553cf8))
* **policy:** deny unknown fields on update policy role body ([#1063](https://github.com/oyatie/console/issues/1063)) ([530a4ab](https://github.com/oyatie/console/commit/530a4ab19e968f827c4c231a859a3e288935637a))
* **policy:** deny unknown fields on update policy role status body ([#1064](https://github.com/oyatie/console/issues/1064)) ([673ed1d](https://github.com/oyatie/console/commit/673ed1d3be8114b8c9f40676d294cb07734996b6))
* **ui:** make island hydration real, design the screens, and record why no browser reaches them ([#1073](https://github.com/oyatie/console/issues/1073)) ([51d939d](https://github.com/oyatie/console/commit/51d939dcf49d2d38daf8d8f299760afabbdd984a))
* **ui:** render Employment Head on shipping HR SSR screens ([#1011](https://github.com/oyatie/console/issues/1011)) ([c7848d7](https://github.com/oyatie/console/commit/c7848d72e59f13aaeba17d22c05da20fa712637f))
* **ui:** render OrgUnit, Company, and Person Heads on shipping SSR screens ([#1010](https://github.com/oyatie/console/issues/1010)) ([9164499](https://github.com/oyatie/console/commit/916449974a511229c7b6ab5f82f184b61543cf06))
* **ui:** serve shipping SSR at conventional public paths ([#1012](https://github.com/oyatie/console/issues/1012)) ([4c3b2d0](https://github.com/oyatie/console/commit/4c3b2d0782bbbeb8eb0b35a52bf76224226701f6))


### Bug Fixes

* **buck:** define CARGO_PKG_VERSION for crates that reach for it ([#1076](https://github.com/oyatie/console/issues/1076)) ([a4447d9](https://github.com/oyatie/console/commit/a4447d98e600c370c34345a3593e28219ac16cbc))
* **buck:** review the Leptos build scripts so reindeer can emit the graph ([#1079](https://github.com/oyatie/console/issues/1079)) ([85502a1](https://github.com/oyatie/console/commit/85502a1a4beadbcc54ad95b0a5dd015db56d9f06))
* **cas:** make the canary say WHICH of three situations produced no cache ([#1091](https://github.com/oyatie/console/issues/1091)) ([37f6cee](https://github.com/oyatie/console/commit/37f6cee981db7fb9686e7c7c4c2b27ff8954b535))
* **deps:** js-yaml 4.3.2 for GHSA-2883-xcg3-v3hh ([#1075](https://github.com/oyatie/console/issues/1075)) ([2faa0bd](https://github.com/oyatie/console/commit/2faa0bd2a7ef81e42a7288d2c8362b766a1b9b01))
* **gate:** teach the personal-data parser that DROP INDEX is column-neutral ([#1078](https://github.com/oyatie/console/issues/1078)) ([9712310](https://github.com/oyatie/console/commit/97123104db364ca4e56e9a9b87374a3cfcfe8aeb))
* make clippy -D warnings green on the workspace ([#1072](https://github.com/oyatie/console/issues/1072)) ([09016f6](https://github.com/oyatie/console/commit/09016f6265eed7fed777df84b94f8a5872ad8277))
* **openapi:** declare canonical links and typed action contracts ([#996](https://github.com/oyatie/console/issues/996)) ([3f4bfba](https://github.com/oyatie/console/commit/3f4bfba0ed8d5893bfb5b93256aee1b63d6b79e1))
* **openapi:** JSON ErrorBody for middleware 401, document 408/413, 429 Retry-After ([#991](https://github.com/oyatie/console/issues/991)) ([1c7a728](https://github.com/oyatie/console/commit/1c7a7285c40defcc428444004d322ece6b473157))
* **openapi:** OpenAPI 3.1 JSON Schema null unions (P0.2) ([#990](https://github.com/oyatie/console/issues/990)) ([0ab93b3](https://github.com/oyatie/console/commit/0ab93b37cb9f505008f30df5d4db3fc5fbb394bf))
* **openapi:** publish Employment GET as_of query (P0.4) ([#995](https://github.com/oyatie/console/issues/995)) ([fd7e698](https://github.com/oyatie/console/commit/fd7e698448565e9ba1fb97389664ca9687f73bf8))
* **openapi:** publish smallest canonical Head schemas (P0.1) ([#994](https://github.com/oyatie/console/issues/994)) ([249a32f](https://github.com/oyatie/console/commit/249a32f5175f919819f0f4a8222d69953dd7b5ff))
* **openapi:** re-anchor three drift assertions to the document's block form ([#1085](https://github.com/oyatie/console/issues/1085)) ([1aa8281](https://github.com/oyatie/console/commit/1aa82814e7d51170bd40fc266ddbfb0ba97c4e5a))
* **openapi:** resolve string-literal .route() request bodies (P0.3) ([#993](https://github.com/oyatie/console/issues/993)) ([6cba0ea](https://github.com/oyatie/console/commit/6cba0ea98d572b87d6c0ecc73dbd8432a106efa2))
* **openapi:** top-level bearer security and HOLD credential-reset (P0.5) ([#992](https://github.com/oyatie/console/issues/992)) ([77dcda5](https://github.com/oyatie/console/commit/77dcda5cf8e91480922058e368514907420e2c91))
* **openapi:** type ontology action execute params on the wire ([#997](https://github.com/oyatie/console/issues/997)) ([ca41baa](https://github.com/oyatie/console/commit/ca41baa80f6dccac308c9a497fa3b7cd31551ed6))

## [0.3.24](https://github.com/oyatie/console/compare/v0.3.23...v0.3.24) (2026-08-29)


### Features

* **intelligence:** loopback-only bind HTTP + fail-closed AIP draft seam ([#972](https://github.com/oyatie/console/issues/972)) ([88e5b42](https://github.com/oyatie/console/commit/88e5b42cf059ae5df1af9e9315e48ea7184c0457))

## [0.3.23](https://github.com/oyatie/console/compare/v0.3.22...v0.3.23) (2026-08-29)


### Features

* **ui:** payroll drill-through hrefs and empty vs denied SSR ([#982](https://github.com/oyatie/console/issues/982)) ([e8e1c75](https://github.com/oyatie/console/commit/e8e1c752d8270da5da2a9af7809410953ad62a91))


### Bug Fixes

* **ontology:** refuse OrgUnit parent cycles longer than 1 ([#981](https://github.com/oyatie/console/issues/981)) ([bd77d31](https://github.com/oyatie/console/commit/bd77d3197813bf6dcfb85947a9e5dba3eef146fb))

## [0.3.22](https://github.com/oyatie/console/compare/v0.3.21...v0.3.22) (2026-08-29)


### Features

* **ontology:** OrgUnit kinds Site/Department/Team ([#975](https://github.com/oyatie/console/issues/975)) ([a8c0758](https://github.com/oyatie/console/commit/a8c075840116ad95af2c8776834d02a02d9d8001))
* **ui:** compose org, HR, and payroll shipping screens on /_ui ([#976](https://github.com/oyatie/console/issues/976)) ([88547eb](https://github.com/oyatie/console/commit/88547eba50a90885187a143837d78a0ebe9c19ab))

## [0.3.21](https://github.com/oyatie/console/compare/v0.3.20...v0.3.21) (2026-08-29)


### Features

* **platform:** backfill Group-of-one and require organizations.group_id ([#971](https://github.com/oyatie/console/issues/971)) ([641b131](https://github.com/oyatie/console/commit/641b131729474fadb03907ee514286a38db23c7b))

## [0.3.20](https://github.com/oyatie/console/compare/v0.3.19...v0.3.20) (2026-08-29)


### Features

* **hr:** mint Person in the same transaction as employee create ([#966](https://github.com/oyatie/console/issues/966)) ([502a383](https://github.com/oyatie/console/commit/502a383cbc0ef80a32a4513b5ed164ad5420cf8d))
* **hr:** refuse unknown OrgUnit/JobPosition UUIDs on create ([#968](https://github.com/oyatie/console/issues/968)) ([0e0f550](https://github.com/oyatie/console/commit/0e0f550e4cbef62edb33583ce0bd9f7a61ea88e9))
* **ui:** compose authorized payroll-run summaries into /_ui SSR ([#959](https://github.com/oyatie/console/issues/959)) ([c69b608](https://github.com/oyatie/console/commit/c69b608d1eb732666d4022c2da8e7e184bfed6c5))
* **ui:** emit a Leptos island around authorized payroll runs ([#962](https://github.com/oyatie/console/issues/962)) ([35c37c1](https://github.com/oyatie/console/commit/35c37c1015efd58e6ce129577a3b25637791df06))
* **ui:** hydrate AuthorizedRuns island via committed WASM ([#964](https://github.com/oyatie/console/issues/964)) ([b602e1f](https://github.com/oyatie/console/commit/b602e1f4f0471dcad3c1987696a64945695811be))

## [0.3.19](https://github.com/oyatie/console/compare/v0.3.18...v0.3.19) (2026-08-28)


### Features

* **ui:** nest empty payroll SSR shell at /_ui ([#952](https://github.com/oyatie/console/issues/952)) ([7bf50ba](https://github.com/oyatie/console/commit/7bf50ba2074e3859b9acf5190aed750757e46a89))
* **ui:** pin leptos 0.9.0-beta on console-payroll-ui ([#951](https://github.com/oyatie/console/issues/951)) ([b69b55c](https://github.com/oyatie/console/commit/b69b55c14e4cbf0cb2ae80089d76fda8b3fb7eca))

## [0.3.18](https://github.com/oyatie/console/compare/v0.3.17...v0.3.18) (2026-08-28)


### Features

* **ui:** admit console-payroll-ui as Layer::Ui with no mount ([#949](https://github.com/oyatie/console/issues/949)) ([26d9725](https://github.com/oyatie/console/commit/26d9725d1fb1c4b70cbe30a397438a2774ac9ffc))

## [0.3.17](https://github.com/oyatie/console/compare/v0.3.16...v0.3.17) (2026-08-28)


### Features

* **ontology:** catalog-required org properties and empty-tenant action path ([#931](https://github.com/oyatie/console/issues/931)) ([b1ba519](https://github.com/oyatie/console/commit/b1ba5195be9c859ac42ead37cd9c6b160eea0ae1))

## [0.3.16](https://github.com/oyatie/console/compare/v0.3.15...v0.3.16) (2026-08-27)


### Features

* **ontology:** owner-adapter list/get for canonical heads ([#898](https://github.com/oyatie/console/issues/898)) ([dd33389](https://github.com/oyatie/console/commit/dd333898b78c599ad5cad3653302ef8880055465))

## [0.3.15](https://github.com/oyatie/console/compare/v0.3.14...v0.3.15) (2026-08-27)


### Features

* **inbox:** ActionInboxSource::{Payroll, Governance} with SoD ([#899](https://github.com/oyatie/console/issues/899)) ([2916a4a](https://github.com/oyatie/console/commit/2916a4a6a14177c9832d64c9e2e6af01e54e17c0))

## [0.3.14](https://github.com/oyatie/console/compare/v0.3.13...v0.3.14) (2026-08-26)


### Bug Fixes

* **identity:** grow DirectoryPerson/DirectoryPage without phone ([#909](https://github.com/oyatie/console/issues/909)) ([88d73bc](https://github.com/oyatie/console/commit/88d73bc41f5804eb59f7f1829b0180a20cf4a557))
* **identity:** omit users.phone from directory list SQL ([#908](https://github.com/oyatie/console/issues/908)) ([6ede402](https://github.com/oyatie/console/commit/6ede40239938d7c0efea2fb191113634b95dc155))
* **lanes:** refuse implementers unless a named probe is red ([#928](https://github.com/oyatie/console/issues/928)) ([db9a690](https://github.com/oyatie/console/commit/db9a690564addaa004fdaf232a66f4aa2be6b476))

## [0.3.13](https://github.com/oyatie/console/compare/v0.3.12...v0.3.13) (2026-08-26)


### Features

* **ui-gate:** Layer::Ui edges; keep frontend HOLD ([#901](https://github.com/oyatie/console/issues/901)) ([2f99f9e](https://github.com/oyatie/console/commit/2f99f9ea26b0813e8962c22a2e74f6376530e69b))

## [0.3.12](https://github.com/oyatie/console/compare/v0.3.11...v0.3.12) (2026-08-25)


### Bug Fixes

* **identity:** govern region and branch mutations ([#872](https://github.com/oyatie/console/issues/872)) ([10f5ab0](https://github.com/oyatie/console/commit/10f5ab0d580f693ca3aad6e2c2f640960006d44e)), closes [#707](https://github.com/oyatie/console/issues/707)

## [0.3.11](https://github.com/oyatie/console/compare/v0.3.10...v0.3.11) (2026-08-24)


### Bug Fixes

* **ci:** wait for delayed release security evidence ([#870](https://github.com/oyatie/console/issues/870)) ([368ecdc](https://github.com/oyatie/console/commit/368ecdca3e94028d398fc8bece0d71b0ee59e0a4))

## [0.3.10](https://github.com/oyatie/console/compare/v0.3.9...v0.3.10) (2026-08-24)


### Bug Fixes

* **ci:** bind image release to fallback proof ([#868](https://github.com/oyatie/console/issues/868)) ([115d878](https://github.com/oyatie/console/commit/115d878dffbd27f7788d51a900844a2b55c60c35))

## [0.3.9](https://github.com/oyatie/console/compare/v0.3.8...v0.3.9) (2026-08-24)


### Features

* **import:** give the ledger a real pay period, and make it immutable ([#844](https://github.com/oyatie/console/issues/844)) ([ac7b014](https://github.com/oyatie/console/commit/ac7b014ed189e5159d1a9d608353ce1e5c4a810c))
* **ontology:** canonical receipts record whose they are ([#850](https://github.com/oyatie/console/issues/850)) ([a7fe1fb](https://github.com/oyatie/console/commit/a7fe1fb7b71c3ab5278cd37e1c3653bf81ab7d4d))
* **ontology:** widen the receipt store so a receipt says whose it is ([#841](https://github.com/oyatie/console/issues/841)) ([d4a689d](https://github.com/oyatie/console/commit/d4a689d5e134e2f98400dedf662cea7d2c3e5f67))
* **payroll:** give payroll_draft_lines a production writer ([#846](https://github.com/oyatie/console/issues/846)) ([5b6cabb](https://github.com/oyatie/console/commit/5b6cabbb4be77c6e62593199d218e73aa8c9c86b))


### Bug Fixes

* **ci:** emit release proof job outputs ([#867](https://github.com/oyatie/console/issues/867)) ([7d0d108](https://github.com/oyatie/console/commit/7d0d1081c009d8f3b3042a6d63788ed13ebe8a30))
* **ci:** make the cluster-global serial group actually group ([#816](https://github.com/oyatie/console/issues/816)) ([e09e9f3](https://github.com/oyatie/console/commit/e09e9f394a0261be666a769b16b03459a4e0d5a0))
* **ci:** recover release PR creation permission failures ([#865](https://github.com/oyatie/console/issues/865)) ([dd09c35](https://github.com/oyatie/console/commit/dd09c35bd89a5907ab213a82ec8e36846b0ea7db))
* **lanes:** make sccache visible and let a lane own a directory ([#818](https://github.com/oyatie/console/issues/818)) ([df54c7d](https://github.com/oyatie/console/commit/df54c7d0ddc825c4ff185a9074a2f2bf227c8b1e))
* **payroll:** a re-stage must not rewind a paid run, or admit unapplied rows ([#834](https://github.com/oyatie/console/issues/834)) ([98b7a0c](https://github.com/oyatie/console/commit/98b7a0cffd9d92827c5392a9493cc73408dea5ae))
* **payroll:** an empty roster must not satisfy the attendance close gate ([#833](https://github.com/oyatie/console/issues/833)) ([409b5c2](https://github.com/oyatie/console/commit/409b5c290d0aca89330dc81ed8d4b6f3f6639269))
* **payroll:** source material must say something, not merely have a column ([#836](https://github.com/oyatie/console/issues/836)) ([c5ac562](https://github.com/oyatie/console/commit/c5ac562f13a0259ee01f3721e9b28cad4d386fb5))


### Performance Improvements

* **ci:** split the expand/contract migration rehearsal off the critical path ([#817](https://github.com/oyatie/console/issues/817)) ([8dbec91](https://github.com/oyatie/console/commit/8dbec91b18e4d970077b5621e8cc1add1d35d8b1))

## [0.3.8](https://github.com/oyatie/console/compare/v0.3.7...v0.3.8) (2026-08-19)


### Bug Fixes

* **authority:** repin the repository after the transfer to the oyatie org ([#801](https://github.com/oyatie/console/issues/801)) ([8f8e0cb](https://github.com/oyatie/console/commit/8f8e0cbdac26aebd84c03b92ba88bc1c0e43baaf))
* **ci:** align the shards on the profile vars, not the ones that already matched ([03e7292](https://github.com/oyatie/console/commit/03e7292d37d6d6cd034372a15b21a4d2cc675926))
* **deps:** bump h2 0.4.14 -&gt; 0.4.16 for RUSTSEC-2026-0258 ([60a9099](https://github.com/oyatie/console/commit/60a9099947b84530efc1848055b2dbbd3cfd2d79))
* **deps:** regenerate third-party/rust/BUCK for the h2 bump ([a8ff2cf](https://github.com/oyatie/console/commit/a8ff2cf9624f2bc26f884def0a1d3a1fb25b12a7))
* **lens:** add the missing regression suite; reject duplicate blocks and unparseable entries ([13d6207](https://github.com/oyatie/console/commit/13d62077aaae94d8554c670470460258167a1ad1))
* **lens:** derive the manifest from AGENTS.md, compare whole blocks, keep README ([5bacf8e](https://github.com/oyatie/console/commit/5bacf8ee031efff9fed5e1f844f4dcb60707c6fa))
* **lens:** reject any numbered-list delimiter, not just the dot ([7705578](https://github.com/oyatie/console/commit/7705578e82a8ef2420e18168c4eec50268e8648c))
* **lens:** reject blank/duplicate identifiers, catalogue the class, schedule the checker ([7511a91](https://github.com/oyatie/console/commit/7511a919e7851026ecb985f9f30ef00c9fad4a3b))
* **payroll:** make `payable` fail closed in the database, not in review ([#793](https://github.com/oyatie/console/issues/793)) ([1532322](https://github.com/oyatie/console/commit/1532322afc72516cd8d0ff8e5ec5a1e155999cd2))


### Performance Improvements

* **ci:** let the postgres shards reach the Rust cache they never could ([bdc6c81](https://github.com/oyatie/console/commit/bdc6c81aa3189d3a8599ecb27085946112d853d5))

## [0.3.7](https://github.com/jason931225/console/compare/v0.3.6...v0.3.7) (2026-08-16)


### Features

* **console:** tracked lane-receipt validator wired into CI preflight (W1.0 pilot) ([#770](https://github.com/jason931225/console/issues/770)) ([d29be0d](https://github.com/jason931225/console/commit/d29be0d73d5d4f6360f8693fc9e0b9e36aef8485))
* **db:** 0218 employee_leave_balances schema (hee2 PR-1) ([#783](https://github.com/jason931225/console/issues/783)) ([97a45cf](https://github.com/jason931225/console/commit/97a45cfc7f937154eeed27f457e6ee50851c4229))
* **hr:** L5-HR UUID attributes + ReassignOrgUnit→hr.transfer (console-y0n) ([#761](https://github.com/jason931225/console/issues/761)) ([681540d](https://github.com/jason931225/console/commit/681540df427c5d64ecc178fbcc1c8bbd11416634))
* **identity:** role-set compare, no-op replay conflict, deactivated-region 409 ([#776](https://github.com/jason931225/console/issues/776)) ([de8fc64](https://github.com/jason931225/console/commit/de8fc6432bd0e24f4033a6ad8e403a644dc87a7e))
* **p4:** retarget Employment owner to the canonical adapter ([#775](https://github.com/jason931225/console/issues/775)) ([86c35b1](https://github.com/jason931225/console/commit/86c35b19035cbda3aba12f43df2c17b9d77a0892))
* **peas:** employment port routing ([#781](https://github.com/jason931225/console/issues/781)) ([fb9ae31](https://github.com/jason931225/console/commit/fb9ae31e6045b6a9beaa8b6dde893890e693d6ee))
* wave-3 admit — 7sx L5-ORG + xxp L5-JOB ([#756](https://github.com/jason931225/console/issues/756)) ([9e29b62](https://github.com/jason931225/console/commit/9e29b627d401db093da9b000a9a2c20002f34037))
* **wave4:** ADR-0030 §7 backend — aggregate path + OpenAPI generator ([#755](https://github.com/jason931225/console/issues/755)) ([84655ce](https://github.com/jason931225/console/commit/84655ce7881c764bbe81081b193cdd2d85d523c1))


### Bug Fixes

* bound release proof head polling ([#787](https://github.com/jason931225/console/issues/787)) ([0e7cfc0](https://github.com/jason931225/console/commit/0e7cfc065f46620982479852b580b0b70236f678))
* **cursor:** ban cross-agent git process/lock races ([#757](https://github.com/jason931225/console/issues/757)) ([111e65a](https://github.com/jason931225/console/commit/111e65a1835ad6078a04f29abaff82c505e2418d))
* **employment:** freeze gate + append-only backdating on the port (rte/r25) ([#780](https://github.com/jason931225/console/issues/780)) ([6a7b27b](https://github.com/jason931225/console/commit/6a7b27b5ff5174db35d04de02b2a1ce2bce98e3d))
* **gates:** decouple G004 policy contract prose ([#771](https://github.com/jason931225/console/issues/771)) ([dea1f91](https://github.com/jason931225/console/commit/dea1f91bf6c336319fc718f9d9f3eb2c2047f63c))
* **gates:** prototype-chain lookup census (console-g14a) ([#762](https://github.com/jason931225/console/issues/762)) ([ae699da](https://github.com/jason931225/console/commit/ae699daed42d0b7dd1a3c833e237eff1bd6dd90f))
* **hardening:** fail closed on source/./timeout argv0 wrappers of real executors ([#778](https://github.com/jason931225/console/issues/778)) ([f0f8c1d](https://github.com/jason931225/console/commit/f0f8c1d63b04bca9f260c6e7238c2590b3cc1b51))
* **hr:** B-EMP-A employment containment (31e/2kd/0hf) ([#779](https://github.com/jason931225/console/issues/779)) ([0da6c2f](https://github.com/jason931225/console/commit/0da6c2fdcc6eadc104527338a4772248f843d43d))
* **hr:** clear exit_date on reactivation (console-90h) ([#766](https://github.com/jason931225/console/issues/766)) ([b2acd80](https://github.com/jason931225/console/commit/b2acd80c4d7f340199b9147f6df9318d74af5f8d))
* **hr:** route employee-row creation through the Employment port (u6ih part-1) ([#782](https://github.com/jason931225/console/issues/782)) ([7fc04e3](https://github.com/jason931225/console/commit/7fc04e3e4167817f6ebc497cb5b329185c2eed5c))
* **identity:** gate replace_user_branches on actor BranchScope (console-o498) ([#759](https://github.com/jason931225/console/issues/759)) ([5770c04](https://github.com/jason931225/console/commit/5770c04c469a842d813ddef6bd2f807e898dd3fc))
* **logistics:** POD corpus from enforced scheme (console-5yn) ([#767](https://github.com/jason931225/console/issues/767)) ([4417bb3](https://github.com/jason931225/console/commit/4417bb377ef65eefc513dad217f886089045eba9))
* **orgchange:** refuse CreateBranch/RenameBranch under deactivated region (console-k6wm) ([#763](https://github.com/jason931225/console/issues/763)) ([950b3b1](https://github.com/jason931225/console/commit/950b3b100f9c619ab920b30110aa14e2e17567df))
* **payroll:** refuse changed provenance on PayRun conflict; recheck drain period gate ([#777](https://github.com/jason931225/console/issues/777)) ([f9a88ed](https://github.com/jason931225/console/commit/f9a88ed192fb7c0588c9c6ba16ea64da84f2887d))
* residual admit — kwm §60 pin, cvh UI sight (+clippy), gc9z LifecycleError, 0lj branch-removal ([#754](https://github.com/jason931225/console/issues/754)) ([e07fffd](https://github.com/jason931225/console/commit/e07fffde0a0b41ea34b1d703ae51b3c5e09fdb8c))

## [0.3.6](https://github.com/jason931225/console/compare/v0.3.5...v0.3.6) (2026-08-11)


### Bug Fixes

* **ci:** ignore doc-comment #[cfg(test)] in executed-tests scan (console-m68) ([#751](https://github.com/jason931225/console/issues/751)) ([59c9c88](https://github.com/jason931225/console/commit/59c9c8861d7a986dc5fc6a25337e38d38f985484))
* **ci:** path-class inventory totals renames + empty-list pin (console-q58y / 7rc) ([#753](https://github.com/jason931225/console/issues/753)) ([76365d6](https://github.com/jason931225/console/commit/76365d67e10a24db1a3f2b9ff844fbe6a4c76f4c))
* **ontology:** console-dgo.2 trusted person_id = employee_id bindings ([#747](https://github.com/jason931225/console/issues/747)) ([5fbd0b2](https://github.com/jason931225/console/commit/5fbd0b2df934cf7d48140e81ff160e63bdd3af0b))

## [0.3.5](https://github.com/jason931225/console/compare/v0.3.4...v0.3.5) (2026-08-11)


### Features

* **leave:** §60⑤ consult workflow + ACTIVE-only coverage headcount ([#745](https://github.com/jason931225/console/issues/745)) ([eca122a](https://github.com/jason931225/console/commit/eca122ad0122457a77b85ca55fc1e8b2e4869e74))
* wave-2 admit — dgo.1 four-eyes, ae5 ExternalSealSigner wire, i91 own-property ([#742](https://github.com/jason931225/console/issues/742)) ([be7b3e1](https://github.com/jason931225/console/commit/be7b3e14b2f126e8c24a2bf99758d0de00aaa23d))


### Bug Fixes

* **payroll:** map PayRun LifecycleError kinds through CanonicalPort ([#741](https://github.com/jason931225/console/issues/741)) ([57fddda](https://github.com/jason931225/console/commit/57fddda198ef3a6e0670aa60ad365417c9f22b2d))
* **release:** admit main squash C after release-please tip bind ([#743](https://github.com/jason931225/console/issues/743)) ([2d5d285](https://github.com/jason931225/console/commit/2d5d285135499d50d20964fd17783ba7fc9c275b))
* **release:** heal poisoned release-please tip committer in converge ([#740](https://github.com/jason931225/console/issues/740)) ([1af779c](https://github.com/jason931225/console/commit/1af779cacb98f46b976c42d98d6de0d9bd1b38c2))

## [0.3.4](https://github.com/jason931225/console/compare/v0.3.3...v0.3.4) (2026-08-11)


### Features

* **p4:** canonical ports writer-ownership gate ([#618](https://github.com/jason931225/console/issues/618)) ([7b568df](https://github.com/jason931225/console/commit/7b568df9db961fa8aa3f36917eaa13c6af2c3023))
* train-2 admit — openapi $ref totality, image-release census, leave §60, external seal signer, collab audience, audit-org threading, crate-disk census, authz AiAssist SSOT ([9acd784](https://github.com/jason931225/console/commit/9acd784f534bb25b0468139be8f9acb13bd8fbd8))


### Bug Fixes

* **p4:** Batch B h3e→avb micro-train — explicit subject_id + CanonicalPort error kinds ([#739](https://github.com/jason931225/console/issues/739)) ([526229d](https://github.com/jason931225/console/commit/526229dd8e3549139083736340f7a474eeeaa402))
* **p4:** Batch B split admit — writer-ownership jth fold, employment valid_to close, canonical dispatch audit + CI wire ([#736](https://github.com/jason931225/console/issues/736)) ([e391abb](https://github.com/jason931225/console/commit/e391abb91c960e4c774fd59c42c64f5e8f87904b))
* **p4:** wave-1 canonical hardening — tai.1 SQL lexer, uoh ambiguous-binding refuse, q06 subject bind ([#622](https://github.com/jason931225/console/issues/622)) ([e86cdd1](https://github.com/jason931225/console/commit/e86cdd1bbd77f024f2ca5236c8af97148e385045))
* **release:** admit release-please bot docs-only candidates (console-9ry) ([#735](https://github.com/jason931225/console/issues/735)) ([f94308a](https://github.com/jason931225/console/commit/f94308a028868e735d61ca7857f3078f85d95598))
* **release:** admit release-please tip documentation custody (console-9ry) ([#737](https://github.com/jason931225/console/issues/737)) ([f478623](https://github.com/jason931225/console/commit/f47862352243a60d4a095db44f52ab56d8527dd5))

## [0.3.3](https://github.com/jason931225/console/compare/v0.3.2...v0.3.3) (2026-08-06)


### Bug Fixes

* unique work_order request_no in docs evidence RLS fixture ([#579](https://github.com/jason931225/console/issues/579)) ([5b9af4c](https://github.com/jason931225/console/commit/5b9af4c72c61aef4ff484269ffd1060fbf714812))

## [0.3.2](https://github.com/jason931225/console/compare/v0.3.1...v0.3.2) (2026-08-04)


### Bug Fixes

* **consolidation:** stabilize the post-pivot restart boundary ([#562](https://github.com/jason931225/console/issues/562)) ([4f58ecf](https://github.com/jason931225/console/commit/4f58ecf138fdc1e829fbe520a45d2ede2de7d837))

## [0.3.1](https://github.com/jason931225/console/compare/v0.3.0...v0.3.1) (2026-08-02)


### Features

* **authority:** the gate learns the new shape before anything is written in it ([#556](https://github.com/jason931225/console/issues/556)) ([327bd72](https://github.com/jason931225/console/commit/327bd723c2f2ad0cce04897a06f1b63463318582))
* **backup:** a 35-day erasure horizon, and a route by which live GitOps may change ([#544](https://github.com/jason931225/console/issues/544)) ([8ef9627](https://github.com/jason931225/console/commit/8ef9627b24be34d2c44e7764ee46abe7761d56de))
* **backup:** a finite retention window, before there is anything to prune ([#535](https://github.com/jason931225/console/issues/535)) ([da8cc40](https://github.com/jason931225/console/commit/da8cc401100470003e07169da6407cd917c7a483))
* **conformance:** add the company-conformance suite — the immutable fan-out target ([#510](https://github.com/jason931225/console/issues/510)) ([fcb1a4c](https://github.com/jason931225/console/commit/fcb1a4c5179c4825357667bb38dc2fcfc2be70eb))
* **conformance:** build the company and job_position types — 4/12 ([#514](https://github.com/jason931225/console/issues/514)) ([8a671bc](https://github.com/jason931225/console/commit/8a671bc0c1cbb40a03ea3265cd6bbefe90529d84))
* **conformance:** build the employment type — 11/12 ([#515](https://github.com/jason931225/console/issues/515)) ([c066e23](https://github.com/jason931225/console/commit/c066e23fa43d57883deb54ca66e0b0e88224e418))
* **conformance:** open the declaration seam the suite shipped without ([#512](https://github.com/jason931225/console/issues/512)) ([7527a03](https://github.com/jason931225/console/commit/7527a03730cdfc5d76404ade7923fee2ef117bf5))
* **erasure-ledger:** an append-only record of what was erased, and what it cannot survive ([#541](https://github.com/jason931225/console/issues/541)) ([b0d836e](https://github.com/jason931225/console/commit/b0d836eae8649616bb9a36dd4a34a6a0857caeab))
* **gate-integrity:** adjudicate H-1..H-4 by execution, and fix the 422 a gate found ([#533](https://github.com/jason931225/console/issues/533)) ([f41cc84](https://github.com/jason931225/console/commit/f41cc847b14ae8a7e265d54ed23dd80970548a2e))
* **ontology:** an audited writer for object policy, and the six reads it gates ([#525](https://github.com/jason931225/console/issues/525)) ([5330914](https://github.com/jason931225/console/commit/5330914c2aa9300eb1d8c1c9673ee74a6860ea74))
* **ontology:** derive declared attributes at writeback — the suite reaches 12/12 ([#516](https://github.com/jason931225/console/issues/516)) ([1d74dc8](https://github.com/jason931225/console/commit/1d74dc8b21bdd204c71137f7513abfdbb0b0d221))
* **ontology:** give the object-type schema FSM an HTTP surface ([#521](https://github.com/jason931225/console/issues/521)) ([a80605e](https://github.com/jason931225/console/commit/a80605ea581bc4b42e10815629c647126ce8fc30))
* **ontology:** move the attach capability to the audited command credential ([#526](https://github.com/jason931225/console/issues/526)) ([a9e51e7](https://github.com/jason931225/console/commit/a9e51e7b7c98600d112e71d9645fec0b0e2446cf))
* **ontology:** project declared property references into live graph edges ([#513](https://github.com/jason931225/console/issues/513)) ([f5910b8](https://github.com/jason931225/console/commit/f5910b8fb123f72ae1a5caae89aac00e691a8c35))
* **payroll:** a 급여명세서 draft that refuses to look finished ([#558](https://github.com/jason931225/console/issues/558)) ([ac57410](https://github.com/jason931225/console/commit/ac574101e3328e6a0218a0057f46744f5e5c9d28))
* **payroll:** make a golden case executable, so a signed figure can fail ([#536](https://github.com/jason931225/console/issues/536)) ([bec30ab](https://github.com/jason931225/console/commit/bec30abaa7126ea3bc8a31651fba9e7ab9e97695))


### Bug Fixes

* **app:** drop the openapi_drift helper orphaned by the client-test removal ([#504](https://github.com/jason931225/console/issues/504)) ([42e9e1c](https://github.com/jason931225/console/commit/42e9e1c2eabcf90b3e99d4d2ff6a2f66addc3fca))
* **authority:** a passing verdict was self-assertable by declaring no reviewer ([#548](https://github.com/jason931225/console/issues/548)) ([03cbcee](https://github.com/jason931225/console/commit/03cbcee404d07483dff443f156980c84753f5e4b))
* **authority:** ten unresolved merge markers sat in the program ledger, and the count grew per merge ([#542](https://github.com/jason931225/console/issues/542)) ([2f640fd](https://github.com/jason931225/console/commit/2f640fd4727dc2b1704a0b29632f947431bcebcc))
* **authz:** six cross-branch read and write defects in registry and identity ([#554](https://github.com/jason931225/console/issues/554)) ([4d9c3d5](https://github.com/jason931225/console/commit/4d9c3d5c3c9250effe53654d5c61685ad08a1497))
* **buck:** pull the pinned PostgreSQL image explicitly, with bounded retry ([#532](https://github.com/jason931225/console/issues/532)) ([dbae035](https://github.com/jason931225/console/commit/dbae0352f67461526ca67d4f0db57a557aa9aebf))
* **ci:** assert the route-source contract against HEAD, not the orphaned candidate ([#507](https://github.com/jason931225/console/issues/507)) ([8b7899d](https://github.com/jason931225/console/commit/8b7899d92c228dc3ef983e17f5c4d907ea141b67))
* **ci:** make six false-green gates fail closed ([#506](https://github.com/jason931225/console/issues/506)) ([d9848ad](https://github.com/jason931225/console/commit/d9848ad2108bfc1de95933a9f929e6d3e0e1c477))
* **ci:** resolve Buck targets by reading BUCK blobs, never by running Buck2 ([#508](https://github.com/jason931225/console/issues/508)) ([294f023](https://github.com/jason931225/console/commit/294f0234cac7b2c96d49613f91da1714401c40df))
* **ci:** the local CI mirror was red on main, and its guard ran nowhere ([#555](https://github.com/jason931225/console/issues/555)) ([e1509f5](https://github.com/jason931225/console/commit/e1509f5e25aa0bb63626112b559c31b485f27a1a))
* **lanes:** one writer per lane, commit as you go, and a probe that checks itself ([#517](https://github.com/jason931225/console/issues/517)) ([451591e](https://github.com/jason931225/console/commit/451591ee8beda53e1c3f3c3c7b40037aa183b0d9))
* **lanes:** route agents to lane worktrees, wire the build cache, unbreak the workflow scripts ([#511](https://github.com/jason931225/console/issues/511)) ([93bac45](https://github.com/jason931225/console/commit/93bac453ddef4643369416cf108299178512520b))
* **openapi:** document the authentication ten operations already require ([#528](https://github.com/jason931225/console/issues/528)) ([18a21d7](https://github.com/jason931225/console/commit/18a21d7cd2035f7fcc0e1ba11f27b33d224c93bb))
* **opentofu:** a missing tfvars planned away the one node that cannot be rebuilt ([#561](https://github.com/jason931225/console/issues/561)) ([9200e87](https://github.com/jason931225/console/commit/9200e875b5362ef88b9a1af20dfc43ed3f07a970))


### Performance Improvements

* **lanes:** sccache never saw a single compilation ([#560](https://github.com/jason931225/console/issues/560)) ([f264689](https://github.com/jason931225/console/commit/f2646890b8c34067d725a857950ac3789b8ab278))

## [0.3.0](https://github.com/jason931225/console/compare/v0.2.2...v0.3.0) (2026-07-28)


### ⚠ BREAKING CHANGES

* clean slate — delete frontend, pivot to the governed object engine ([#503](https://github.com/jason931225/console/issues/503))

### Bug Fixes

* **release:** sync package-lock to the 0.2.2 bump that landed without it ([#501](https://github.com/jason931225/console/issues/501)) ([39701a2](https://github.com/jason931225/console/commit/39701a2c3dbacc3b715259a608f6fa8ef531fd39))


### Miscellaneous Chores

* clean slate — delete frontend, pivot to the governed object engine ([#503](https://github.com/jason931225/console/issues/503)) ([962fb98](https://github.com/jason931225/console/commit/962fb98b739e330c660f922374cebfbd6d10a239))

## [0.2.2](https://github.com/jason931225/console/compare/v0.2.1...v0.2.2) (2026-07-27)


### Features

* **console:** land the console program spine on main ([#493](https://github.com/jason931225/console/issues/493)) ([78cf160](https://github.com/jason931225/console/commit/78cf1600fd43fa014bc778a9125ddf43956f288e))


### Bug Fixes

* **ci:** size the messenger-mutation budget to measurement and let xcodebuild finalize ([#496](https://github.com/jason931225/console/issues/496)) ([6655747](https://github.com/jason931225/console/commit/665574758e568e809d9ca480e7df107a8ee6ee23))
* **console:** drop the AX5-occluded selected badge and settle the audit viewport ([#500](https://github.com/jason931225/console/issues/500)) ([c1a68d3](https://github.com/jason931225/console/commit/c1a68d3b0d35859303b727b15d5f4a0992c2ce05))
* **console:** land the rename remnants [#497](https://github.com/jason931225/console/issues/497) merged without ([#499](https://github.com/jason931225/console/issues/499)) ([28ad6ef](https://github.com/jason931225/console/commit/28ad6ef9d5f2b0348dfa0fa420324a3a2ca01ddb))
* **console:** retire the last product-naming remnants ([#497](https://github.com/jason931225/console/issues/497)) ([6822161](https://github.com/jason931225/console/commit/682216103954228c722338b38593c16e720d761a))

## [0.2.1](https://github.com/jason931225/maintenance/compare/v0.2.0...v0.2.1) (2026-07-23)


### Bug Fixes

* **ci:** make iOS post-login E2E hermetic ([#486](https://github.com/jason931225/maintenance/issues/486)) ([3740621](https://github.com/jason931225/maintenance/commit/374062131be1a023bd4e0a644c0978357c53d276))

## [0.2.0](https://github.com/jason931225/maintenance/compare/v0.1.65...v0.2.0) (2026-07-22)


### ⚠ BREAKING CHANGES

* **coss:** The shipped coss-rn standalone public site and its npm workspace are removed without an in-repository replacement.

### Features

* **coss:** retire standalone public-site surface ([87241f3](https://github.com/jason931225/maintenance/commit/87241f30ef40b35ba188330a6b5db726b9f718b5))


### Bug Fixes

* **web:** patch curl CVEs in runtime image ([#483](https://github.com/jason931225/maintenance/issues/483)) ([5fd4993](https://github.com/jason931225/maintenance/commit/5fd49930405bb8d2457dbfc606e116710a3b2f58))

## [0.1.65](https://github.com/jason931225/maintenance/compare/v0.1.64...v0.1.65) (2026-07-22)


### Bug Fixes

* **ci:** make Android post-login E2E hermetic ([#481](https://github.com/jason931225/maintenance/issues/481)) ([0b70738](https://github.com/jason931225/maintenance/commit/0b70738a26d4643f6d083a47ecc70c543b0d869d))

## [0.1.64](https://github.com/jason931225/maintenance/compare/v0.1.63...v0.1.64) (2026-07-21)


### Bug Fixes

* **ci:** align mobile session bootstrap contracts ([#479](https://github.com/jason931225/maintenance/issues/479)) ([0cae5a6](https://github.com/jason931225/maintenance/commit/0cae5a6028bdba1b9822492f60780e5ab73de599))

## [0.1.63](https://github.com/jason931225/maintenance/compare/v0.1.62...v0.1.63) (2026-07-21)


### Features

* **platform:** stage DARK workflows and governed PostgreSQL 18 boundaries ([#473](https://github.com/jason931225/maintenance/issues/473)) ([26f56aa](https://github.com/jason931225/maintenance/commit/26f56aae7e33d6cd63fd91fe75c89ca76d0118ae))

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
