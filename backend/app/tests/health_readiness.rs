use std::time::Duration;

use axum::body::Body;
use console_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use http::{Request, StatusCode};
use sqlx::postgres::PgPoolOptions;
use tower::ServiceExt;

#[tokio::test]
async fn healthz_reports_process_liveness_and_role() -> Result<(), Box<dyn std::error::Error>> {
    let config = app_config(AppRole::Api)?;
    let state = AppState::new(config, DatabaseDependency::NotConfigured)?;
    let response = build_router(state)
        .oneshot(Request::builder().uri("/healthz").body(Body::empty())?)
        .await?;

    assert_eq!(response.status(), StatusCode::OK);
    Ok(())
}

#[tokio::test]
async fn readyz_is_ready_without_configured_dependencies() -> Result<(), Box<dyn std::error::Error>>
{
    let config = app_config(AppRole::Worker)?;
    let state = AppState::new(config, DatabaseDependency::NotConfigured)?;
    let response = build_router(state)
        .oneshot(Request::builder().uri("/readyz").body(Body::empty())?)
        .await?;

    assert_eq!(response.status(), StatusCode::OK);
    Ok(())
}

#[tokio::test]
async fn readyz_returns_503_when_configured_database_is_unreachable()
-> Result<(), Box<dyn std::error::Error>> {
    let config = app_config(AppRole::Api)?;
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_millis(100))
        .connect_lazy("postgres://console_app:wrong@127.0.0.1:1/console_missing")?;
    let state = AppState::new(config, DatabaseDependency::Postgres(pool))?;
    let response = build_router(state)
        .oneshot(Request::builder().uri("/readyz").body(Body::empty())?)
        .await?;

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    Ok(())
}

#[tokio::test]
async fn metrics_endpoint_exposes_the_slo_http_duration_histogram()
-> Result<(), Box<dyn std::error::Error>> {
    // The global recorder is process-wide and shared across this test binary;
    // installation is idempotent and the unique service_name isolates this
    // test's series from any other test's measured requests.
    console_app::install_metrics_recorder()?;
    let config = AppConfig::from_pairs([
        ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ("CONSOLE_SERVICE_NAME", "console-app-api".to_owned()),
    ])?;
    let state = AppState::new(config, DatabaseDependency::NotConfigured)?;
    let app = build_router(state);

    // One measured request so the histogram has at least one observation.
    let health = app
        .clone()
        .oneshot(Request::builder().uri("/healthz").body(Body::empty())?)
        .await?;
    assert_eq!(health.status(), StatusCode::OK);

    // Policy Studio emits a feature counter from the identity router. Exercise
    // the same bounded label shape here so the scrape path proves both the
    // generic RED histogram and feature-specific operation counters are exposed.
    metrics::counter!(
        "policy_studio_operation_total",
        "operation" => "preview_assignments",
        "outcome" => "success",
    )
    .increment(1);

    let metrics = app
        .oneshot(Request::builder().uri("/metrics").body(Body::empty())?)
        .await?;
    assert_eq!(metrics.status(), StatusCode::OK);
    let body = axum::body::to_bytes(metrics.into_body(), usize::MAX).await?;
    let text = String::from_utf8(body.to_vec())?;
    assert!(
        text.contains("http_server_request_duration_seconds_bucket"),
        "exposition must include the SLO latency histogram buckets; got:\n{text}"
    );
    assert!(
        text.contains("service_name=\"console-app-api\""),
        "histogram series must carry the service_name label the SLO filters on; got:\n{text}"
    );
    assert!(
        text.contains("policy_studio_operation_total")
            && text.contains("operation=\"preview_assignments\"")
            && text.contains("outcome=\"success\""),
        "policy studio counter must expose only bounded operation/outcome labels; got:\n{text}"
    );
    Ok(())
}

#[tokio::test]
async fn ui_shell_serves_empty_ssr_html() -> Result<(), Box<dyn std::error::Error>> {
    let config = app_config(AppRole::Api)?;
    let state = AppState::new(config, DatabaseDependency::NotConfigured)?;
    let app = build_router(state);
    let mut last = String::new();
    for uri in ["/", "/organization", "/hr", "/payroll"] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(uri).body(Body::empty())?)
            .await?;
        if response.status() != StatusCode::OK {
            last = format!("{uri} {}", response.status());
            continue;
        }
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
        let text = String::from_utf8(body.to_vec())?;
        assert_eq!(text, console_payroll_ui::render_shell());
        assert!(
            !text.contains("291_520") && !text.to_ascii_lowercase().contains("payslip"),
            "{uri} leaked payroll: {text}"
        );
        return Ok(());
    }
    Err(format!("/ did not return 200 ({last})").into())
}

#[tokio::test]
async fn ui_pkg_serves_committed_hydrate_assets() -> Result<(), Box<dyn std::error::Error>> {
    let config = app_config(AppRole::Api)?;
    let state = AppState::new(config, DatabaseDependency::NotConfigured)?;
    let app = build_router(state);
    let cases: [(&str, &[u8], &[u8]); 2] = [
        (
            "/pkg/console_payroll_ui.js",
            b"text/javascript; charset=utf-8",
            console_payroll_ui::payroll_ui_js(),
        ),
        (
            "/pkg/console_payroll_ui_bg.wasm",
            b"application/wasm",
            console_payroll_ui::payroll_ui_wasm(),
        ),
    ];
    for (uri, mime, expected) in cases {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(uri).body(Body::empty())?)
            .await?;
        assert_eq!(response.status(), StatusCode::OK, "{uri}");
        assert_eq!(
            response
                .headers()
                .get(http::header::CONTENT_TYPE)
                .map(http::HeaderValue::as_bytes),
            Some(mime),
            "{uri}"
        );
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
        assert_eq!(body.as_ref(), expected, "{uri}");
    }
    Ok(())
}

fn app_config(role: AppRole) -> Result<AppConfig, console_app::AppError> {
    AppConfig::from_pairs([
        ("CONSOLE_APP_ROLE", role.to_string()),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
    ])
}

mod authorized {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;
    use axum::body::to_bytes;
    use console_kernel_core::{OrgId, UserId};
    use console_ontology_canonical_adapter_postgres::company::{
        CompanyCommand, CompanyQuery, PgCompanyPort,
    };
    use console_ontology_canonical_adapter_postgres::employment::{
        EmploymentAttributes, EmploymentCommand, EmploymentQuery, PgEmploymentPort,
    };
    use console_ontology_canonical_adapter_postgres::org_unit::{
        OrgUnitCommand, OrgUnitQuery, PgOrgUnitPort,
    };
    use console_ontology_canonical_adapter_postgres::person::{
        PersonCommand, PersonQuery, PgPersonPort,
    };
    use console_ontology_canonical_domain::{CanonicalPort, CommandId, DispatchTarget};
    use console_payroll_adapter_postgres::pay_run::{PayRunCommand, PayRunQuery, PgPayRunPort};
    use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings};
    use http::header;
    use p256::ecdsa::SigningKey;
    use p256::elliptic_curve::rand_core::OsRng;
    use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
    use serde_json::json;
    use sqlx::PgPool;
    use time::OffsetDateTime;
    use time::macros::date;
    use uuid::Uuid;

    const TEST_ISSUER: &str = "console-platform-auth";
    const TEST_AUDIENCE: &str = "console-api";

    struct Keys {
        private_pem: String,
        public_pem: String,
    }

    fn keys() -> Keys {
        let signing_key = SigningKey::random(&mut OsRng);
        Keys {
            private_pem: signing_key
                .to_pkcs8_pem(LineEnding::LF)
                .unwrap()
                .to_string(),
            public_pem: signing_key
                .verifying_key()
                .to_public_key_pem(LineEnding::LF)
                .unwrap(),
        }
    }

    fn bearer(keys: &Keys, org: OrgId, user: UserId, role: &str) -> String {
        let issuer = JwtIssuer::from_es256_pem(
            JwtSettings {
                issuer: TEST_ISSUER.to_owned(),
                audience: TEST_AUDIENCE.to_owned(),
                access_token_ttl: time::Duration::minutes(15),
            },
            keys.private_pem.as_bytes(),
            keys.public_pem.as_bytes(),
        )
        .unwrap();
        issuer
            .issue_access_token(AccessTokenInput {
                subject: user,
                org_id: org,
                roles: vec![role.to_owned()],
                branches: Vec::new(),
                platform: false,
                view_as: false,
                read_only: false,
                display_name: None,
                feature_grants: Vec::new(),
                authz_subject_version: 0,
                authz_policy_version: 0,
                session_generation: 0,
                issued_at: OffsetDateTime::now_utc(),
            })
            .unwrap()
    }

    async fn runtime_role_pool(owner: &PgPool) -> PgPool {
        PgPoolOptions::new()
            .max_connections(4)
            .after_connect(|conn, _| {
                Box::pin(async move {
                    sqlx::query("SET ROLE console_rt").execute(conn).await?;
                    Ok(())
                })
            })
            .connect_with(owner.connect_options().as_ref().clone())
            .await
            .unwrap()
    }

    fn jwt_app_state(runtime_pool: PgPool, public_key_pem: String) -> AppState {
        let config = AppConfig::from_pairs([
            ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
            ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
            ("CONSOLE_JWT_ISSUER", TEST_ISSUER.to_owned()),
            ("CONSOLE_JWT_AUDIENCE", TEST_AUDIENCE.to_owned()),
            ("CONSOLE_JWT_PUBLIC_KEY_PEM", public_key_pem),
        ])
        .unwrap();
        AppState::new(config, DatabaseDependency::Postgres(runtime_pool)).unwrap()
    }

    async fn seed_user(pool: &PgPool, org: OrgId, user: UserId, role: &str) {
        sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
            .bind(*user.as_uuid())
            .bind(format!("ui-{role}"))
            .bind(vec![role.to_owned()])
            .bind(*org.as_uuid())
            .execute(pool)
            .await
            .unwrap();
    }

    async fn seed_run(pool: &PgPool, org: OrgId, actor: UserId) -> Uuid {
        let pay_run = PgPayRunPort::new(
            runtime_role_pool(pool).await,
            tokio::runtime::Handle::current(),
        );
        let created = {
            let port = pay_run.clone();
            let command = PayRunCommand {
                org_id: org,
                command_id: CommandId::from_uuid(Uuid::new_v4()),
                actor_id: actor,
                query: PayRunQuery::CreateRun {
                    run_id: Uuid::new_v4(),
                    period_start: date!(2026 - 06 - 01),
                    period_end: date!(2026 - 06 - 30),
                    connector: Some("m2".to_owned()),
                    job: Some("payroll_draft".to_owned()),
                },
                action_key: "create_run".to_owned(),
                object_type_id: Uuid::nil(),
            };
            tokio::task::spawn_blocking(move || port.execute(&command))
                .await
                .unwrap()
                .expect("payroll.create_run as console_rt")
        };
        assert_eq!(created.target(), DispatchTarget::PayrollCreateRun);
        created.result()["draft_run_id"]
            .as_str()
            .expect("CreateRun must name draft_run_id")
            .parse()
            .unwrap()
    }

    struct SeededHeads {
        person_id: Uuid,
        org_unit_id: Uuid,
        employment_id: Uuid,
    }

    async fn seed_heads(pool: &PgPool, org: OrgId, actor: UserId) -> SeededHeads {
        let runtime = runtime_role_pool(pool).await;
        let handle = tokio::runtime::Handle::current();
        let company = PgCompanyPort::new(runtime.clone(), handle.clone());
        let company_cmd = CompanyCommand {
            org_id: org,
            command_id: CommandId::from_uuid(Uuid::new_v4()),
            actor_id: actor,
            query: CompanyQuery {
                attributes: json!({ "legal_name": "KNL" }),
            },
            action_key: "revise".to_owned(),
            object_type_id: Uuid::nil(),
        };
        tokio::task::spawn_blocking(move || company.execute(&company_cmd))
            .await
            .unwrap()
            .expect("company.revise as console_rt");

        let units = PgOrgUnitPort::new(runtime.clone(), handle.clone());
        let unit_cmd = OrgUnitCommand {
            org_id: org,
            command_id: CommandId::from_uuid(Uuid::new_v4()),
            actor_id: actor,
            query: OrgUnitQuery::Create {
                source: None,
                attributes: json!({ "name": "본사", "kind": "site" }),
            },
            action_key: "create_org_unit".to_owned(),
            object_type_id: Uuid::nil(),
        };
        let created_unit = tokio::task::spawn_blocking(move || units.execute(&unit_cmd))
            .await
            .unwrap()
            .expect("organization.create_org_unit as console_rt");
        let org_unit_id = created_unit.result()["org_unit_id"]
            .as_str()
            .expect("create_org_unit must name org_unit_id")
            .parse()
            .unwrap();

        let employee_id: Uuid = sqlx::query_scalar(
            "INSERT INTO employees \
             (org_id, company, name, source_filename, source_sheet, source_row, source_key) \
             VALUES ($1, 'KNL', '홍길동', 'seed.xlsx', 'Sheet1', 1, $2) RETURNING id",
        )
        .bind(*org.as_uuid())
        .bind(format!("ui-employment-{}", actor.as_uuid()))
        .fetch_one(pool)
        .await
        .unwrap();

        let persons = PgPersonPort::new(runtime.clone(), handle.clone());
        let person_cmd = PersonCommand {
            org_id: org,
            command_id: CommandId::from_uuid(Uuid::new_v4()),
            actor_id: actor,
            query: PersonQuery::Create {
                employee_id: Some(employee_id),
                attributes: json!({ "legal_name": "홍길동", "display_name": "홍길동" }),
            },
            action_key: "create_person".to_owned(),
            object_type_id: Uuid::nil(),
        };
        let created_person = tokio::task::spawn_blocking(move || persons.execute(&person_cmd))
            .await
            .unwrap()
            .expect("people.create_person as console_rt");
        let person_id = created_person.result()["person_id"]
            .as_str()
            .expect("create_person must name person_id")
            .parse()
            .unwrap();

        let employments = PgEmploymentPort::new(runtime, handle);
        let appoint_cmd = EmploymentCommand {
            org_id: org,
            command_id: CommandId::from_uuid(Uuid::new_v4()),
            actor_id: actor,
            query: EmploymentQuery::Appoint {
                employee_id,
                valid_from: OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap(),
                attributes: EmploymentAttributes {
                    company: "KNL".to_owned(),
                    org_unit_id: Some(org_unit_id),
                    job_position_id: None,
                    employment_status: "ACTIVE".to_owned(),
                },
            },
            action_key: "revise".to_owned(),
            object_type_id: Uuid::nil(),
        };
        let created_employment =
            tokio::task::spawn_blocking(move || employments.execute(&appoint_cmd))
                .await
                .unwrap()
                .expect("hr.appoint as console_rt");
        let employment_id = created_employment.result()["employment_id"]
            .as_str()
            .expect("hr.appoint must name employment_id")
            .parse()
            .unwrap();
        SeededHeads {
            person_id,
            org_unit_id,
            employment_id,
        }
    }

    /// ADR-0042 tripwire. This is **not** a claim that the behavior is correct.
    ///
    /// A browser cannot attach `Authorization` to a top-level navigation, and
    /// `bearer_token()` accepts no other transport, so a person who navigates to
    /// the SSR screens gets the empty shell however they authenticated. Every
    /// other UI test sets the header programmatically, as an HTTP client must,
    /// so the suite proves composition is right GIVEN a principal and says
    /// nothing about whether the intended client can supply one. This pins that
    /// asymmetry where a reader of the suite can see it.
    ///
    /// What it does NOT do is detect an arbitrary future transport. It sends
    /// one credential shape -- `console_refresh` carrying an access token --
    /// so it goes red only for a fix that reuses that exact cookie. ADR-0042's
    /// recommended option mints a *new* cookie beside the existing pair, and
    /// the client-bootstrap option keeps serving this very shell, so neither
    /// would turn this red. Treat it as a pin on today's behavior and a
    /// pointer to the ADR, not as a gate on the fix: when a transport lands,
    /// delete this and put the positive test in its place -- a
    /// navigation-shaped request renders the authorized screens.
    ///
    /// The cookie is deliberately unrealistic in the browser's favor.
    /// `console_refresh` is `HttpOnly; SameSite=Strict; Path=/api/v1/auth` and
    /// carries a refresh token, so a real browser would never send it to `/`
    /// and it would never hold an access token. Handing it one anyway makes
    /// the negative result stronger, not representative.
    #[sqlx::test(migrations = "../crates/platform/db/migrations")]
    async fn browser_navigation_reaches_no_authorized_screen_adr_0042(pool: PgPool) {
        let keys = keys();
        let org = OrgId::knl();
        let admin = UserId::new();
        seed_user(&pool, org, admin, "SUPER_ADMIN").await;
        let run = seed_run(&pool, org, admin).await;
        let service = build_router(jwt_app_state(
            runtime_role_pool(&pool).await,
            keys.public_pem.clone(),
        ));
        let token = bearer(&keys, org, admin, "SUPER_ADMIN");

        // One principal, over the transport an HTTP client can use.
        let (status, with_header) = get_ui(service.clone(), Some(&token)).await;
        assert_eq!(status, StatusCode::OK, "{with_header}");
        assert!(
            with_header.contains(&format!("data-run-id=\"{run}\"")),
            "header transport must reach the authorized run: {with_header}"
        );
        assert!(
            with_header.contains("leptos-island"),
            "header transport must reach the hydrated island: {with_header}"
        );

        // The same principal, over what a browser navigation can carry.
        // Generous on purpose: this hands the browser a real access token in
        // the only cookie the system sets at all -- a cookie that is
        // path-scoped away from `/` and never holds an access token. Even so
        // the page is empty.
        let navigation = Request::builder()
            .uri("/")
            .header(
                header::USER_AGENT,
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            )
            .header(header::ACCEPT, "text/html,application/xhtml+xml")
            .header(header::COOKIE, format!("console_refresh={token}"))
            .header("upgrade-insecure-requests", "1")
            .body(Body::empty())
            .unwrap();
        let response = service.oneshot(navigation).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let navigated = String::from_utf8(bytes.to_vec()).unwrap();

        assert_eq!(
            navigated,
            console_payroll_ui::render_shell(),
            "ADR-0042: a navigation still renders the empty shell. If this line \
             failed, a cookie transport now exists -- replace this test with \
             the positive one rather than loosening it."
        );
        assert!(
            !navigated.contains(&run.to_string()) && !navigated.contains("leptos-island"),
            "the empty shell must leak neither the run nor the island: {navigated}"
        );
    }

    async fn get_ui(app: axum::Router, token: Option<&str>) -> (StatusCode, String) {
        get_ui_path(app, "/", token).await
    }

    async fn get_ui_path(
        app: axum::Router,
        uri: &str,
        token: Option<&str>,
    ) -> (StatusCode, String) {
        let mut builder = Request::builder().uri(uri);
        if let Some(token) = token {
            builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        let response = app
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    #[sqlx::test(migrations = "../crates/platform/db/migrations")]
    async fn ui_shell_omits_runs_unless_payroll_run_read(pool: PgPool) {
        let keys = keys();
        let org = OrgId::knl();
        let super_admin = UserId::new();
        seed_user(&pool, org, super_admin, "SUPER_ADMIN").await;
        let member = UserId::new();
        seed_user(&pool, org, member, "MEMBER").await;
        let run = seed_run(&pool, org, super_admin).await;

        let service = build_router(jwt_app_state(
            runtime_role_pool(&pool).await,
            keys.public_pem.clone(),
        ));

        let (status, unauth) = get_ui(service.clone(), None).await;
        assert_eq!(status, StatusCode::OK, "{unauth}");
        assert_eq!(unauth, console_payroll_ui::render_shell());
        assert!(
            !unauth.contains("/pkg/"),
            "empty shell must not load WASM: {unauth}"
        );

        let (status, member_html) =
            get_ui(service.clone(), Some(&bearer(&keys, org, member, "MEMBER"))).await;
        assert_eq!(status, StatusCode::OK, "{member_html}");
        assert_eq!(member_html, console_payroll_ui::render_shell());
        assert!(
            !member_html.contains(&run.to_string()),
            "MEMBER must not see the run id: {member_html}"
        );
        assert!(
            !member_html.contains("/pkg/"),
            "MEMBER shell must not load WASM: {member_html}"
        );

        let (status, admin_html) = get_ui(
            service,
            Some(&bearer(&keys, org, super_admin, "SUPER_ADMIN")),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{admin_html}");
        assert_ne!(admin_html, console_payroll_ui::render_shell());
        assert!(
            admin_html.contains(&format!("data-run-id=\"{run}\"")),
            "SUPER_ADMIN must see the authorized run: {admin_html}"
        );
        assert!(
            admin_html.contains("/pkg/console_payroll_ui.js"),
            "authorized shell must preload bindgen js: {admin_html}"
        );
        let lowered = admin_html.to_ascii_lowercase();
        assert!(!lowered.contains("won"), "won leaked: {admin_html}");
        assert!(
            !admin_html.contains("291_520"),
            "golden won leaked: {admin_html}"
        );
        assert!(!lowered.contains("payslip"), "payslip leaked: {admin_html}");
    }

    async fn grant_group_viewer(pool: &PgPool, org: OrgId, user: UserId) {
        sqlx::query(
            "INSERT INTO group_role_grants (group_id, user_id, group_role) \
             SELECT group_id, $1, 'GROUP_VIEWER' FROM organizations WHERE id = $2",
        )
        .bind(*user.as_uuid())
        .bind(*org.as_uuid())
        .execute(pool)
        .await
        .unwrap();
    }

    #[sqlx::test(migrations = "../crates/platform/db/migrations")]
    async fn ui_shipping_screens_deny_by_omission(pool: PgPool) {
        let keys = keys();
        let org = OrgId::knl();
        let super_admin = UserId::new();
        seed_user(&pool, org, super_admin, "SUPER_ADMIN").await;
        grant_group_viewer(&pool, org, super_admin).await;
        let member = UserId::new();
        seed_user(&pool, org, member, "MEMBER").await;
        let run = seed_run(&pool, org, super_admin).await;
        let heads = seed_heads(&pool, org, super_admin).await;

        let service = build_router(jwt_app_state(
            runtime_role_pool(&pool).await,
            keys.public_pem.clone(),
        ));
        let admin = bearer(&keys, org, super_admin, "SUPER_ADMIN");
        let member_tok = bearer(&keys, org, member, "MEMBER");

        for uri in ["/", "/organization", "/hr", "/payroll"] {
            let (status, html) = get_ui_path(service.clone(), uri, Some(&member_tok)).await;
            assert_eq!(status, StatusCode::OK, "{uri} {html}");
            assert_eq!(html, console_payroll_ui::render_shell(), "{uri}");
            assert!(
                !html.contains("data-screen="),
                "MEMBER must omit shipping screens at {uri}: {html}"
            );
        }

        let (status, org_html) = get_ui_path(service.clone(), "/organization", Some(&admin)).await;
        assert_eq!(status, StatusCode::OK, "{org_html}");
        assert!(
            org_html.contains("data-screen=\"organization\"")
                && org_html.contains(&format!("data-org-id=\"{}\"", org.as_uuid()))
                && org_html.contains("data-legal-name=")
                && org_html.contains(&format!("data-org-unit-id=\"{}\"", heads.org_unit_id))
                && org_html.contains(&format!("href=\"/api/v1/companies/{}\"", org.as_uuid()))
                && org_html.contains(&format!("href=\"/api/v1/org-units/{}\"", heads.org_unit_id))
                && !org_html.contains("data-slug"),
            "SUPER_ADMIN organization screen must render published Company/OrgUnit Heads: {org_html}"
        );
        assert!(
            !org_html.contains("/pkg/"),
            "organization SSR must not load WASM: {org_html}"
        );

        let (status, hr_html) = get_ui_path(service.clone(), "/hr", Some(&admin)).await;
        assert_eq!(status, StatusCode::OK, "{hr_html}");
        assert!(
            hr_html.contains("data-screen=\"hr\"")
                && hr_html.contains(&format!("data-person-id=\"{}\"", heads.person_id))
                && hr_html.contains("data-legal-name=")
                && hr_html.contains(&format!("href=\"/api/v1/persons/{}\"", heads.person_id))
                && hr_html.contains(&format!("data-employment-id=\"{}\"", heads.employment_id))
                && hr_html.contains(&format!(
                    "href=\"/api/v1/employments/{}\"",
                    heads.employment_id
                ))
                && hr_html.contains("data-appointed-on=")
                && hr_html.contains("data-job-position-id=")
                && !hr_html.contains("/api/v1/job-positions/")
                && !hr_html.contains("data-employee-"),
            "SUPER_ADMIN HR screen must render published Person and Employment Heads: {hr_html}"
        );
        assert!(
            !hr_html.to_ascii_lowercase().contains("phone"),
            "HR screen leaked phone: {hr_html}"
        );
        assert!(
            !hr_html.contains("/pkg/"),
            "HR SSR must not load WASM: {hr_html}"
        );

        let (status, payroll_html) = get_ui_path(service.clone(), "/payroll", Some(&admin)).await;
        assert_eq!(status, StatusCode::OK, "{payroll_html}");
        assert!(
            payroll_html.contains("data-screen=\"payroll\"")
                && payroll_html.contains(&format!("data-run-id=\"{run}\"")),
            "SUPER_ADMIN payroll screen must render authorized runs: {payroll_html}"
        );
        assert!(
            payroll_html.contains("/pkg/console_payroll_ui.js"),
            "payroll island must hydrate via committed WASM: {payroll_html}"
        );
        let lowered = payroll_html.to_ascii_lowercase();
        assert!(!lowered.contains("won"), "won leaked: {payroll_html}");
        assert!(!lowered.contains("group-switcher"), "{payroll_html}");
        assert!(!lowered.contains("comms-rail"), "{payroll_html}");
    }

    async fn list_read_audits(pool: &PgPool, actor: UserId) -> i64 {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM audit_events \
             WHERE action = 'payroll_run.list_read' AND actor = $1",
        )
        .bind(*actor.as_uuid())
        .fetch_one(pool)
        .await
        .unwrap()
    }

    fn assert_ui_invariants(html: &str) {
        let lowered = html.to_ascii_lowercase();
        assert!(!lowered.contains("won"), "won leaked: {html}");
        assert!(!html.contains("291_520"), "golden won leaked: {html}");
        assert!(!lowered.contains("payslip"), "payslip leaked: {html}");
        assert!(!lowered.contains("phone"), "directory phone leaked: {html}");
        assert!(!lowered.contains("group-switcher"), "{html}");
        assert!(!lowered.contains("comms-rail"), "{html}");
        assert!(
            !html.contains("type=\"file\"") && !html.contains("자료실"),
            "import/export is not the data-entry base: {html}"
        );
        assert!(
            !html.contains("webpack") && !html.contains("vite") && !html.contains("innerHTML"),
            "must stay Rust-native Leptos SSR: {html}"
        );
        assert!(
            !html.contains("/api/v1/job-positions/"),
            "must not invent JobPosition routes: {html}"
        );
        assert!(
            !html.contains("type=\"date\"")
                && !html.contains("name=\"as_of\"")
                && !html.contains("name=\"from\"")
                && !html.contains("name=\"to\""),
            "current-slice directory must not invent a temporal picker: {html}"
        );
    }

    /// ADR-0025 §4 persona real-backend E2E on `/`, `/organization`, `/hr`, `/payroll`.
    #[sqlx::test(migrations = "../crates/platform/db/migrations")]
    async fn ui_persona_e2e(pool: PgPool) {
        let keys = keys();
        let org = OrgId::knl();
        let member = UserId::new();
        let admin = UserId::new();
        let executive = UserId::new();
        let super_admin = UserId::new();
        seed_user(&pool, org, member, "MEMBER").await;
        seed_user(&pool, org, admin, "ADMIN").await;
        seed_user(&pool, org, executive, "EXECUTIVE").await;
        seed_user(&pool, org, super_admin, "SUPER_ADMIN").await;
        grant_group_viewer(&pool, org, admin).await;
        grant_group_viewer(&pool, org, executive).await;
        grant_group_viewer(&pool, org, super_admin).await;
        let run = seed_run(&pool, org, super_admin).await;
        let heads = seed_heads(&pool, org, super_admin).await;

        let other_org = OrgId::from_uuid(Uuid::from_u128(0xb2));
        sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)")
            .bind(*other_org.as_uuid())
            .bind("persona-e2e-other")
            .bind("Persona E2E other org")
            .execute(&pool)
            .await
            .unwrap();
        let foreign = UserId::new();
        seed_user(&pool, other_org, foreign, "SUPER_ADMIN").await;
        grant_group_viewer(&pool, other_org, foreign).await;

        let service = build_router(jwt_app_state(
            runtime_role_pool(&pool).await,
            keys.public_pem.clone(),
        ));
        let member_tok = bearer(&keys, org, member, "MEMBER");
        let admin_tok = bearer(&keys, org, admin, "ADMIN");
        let exec_tok = bearer(&keys, org, executive, "EXECUTIVE");
        let super_tok = bearer(&keys, org, super_admin, "SUPER_ADMIN");
        let foreign_tok = bearer(&keys, other_org, foreign, "SUPER_ADMIN");
        let routes = ["/", "/organization", "/hr", "/payroll"];
        let org_id = org.as_uuid().to_string();
        let run_id = run.to_string();

        for uri in routes {
            let (status, html) = get_ui_path(service.clone(), uri, None).await;
            assert_eq!(status, StatusCode::OK, "unauth {uri} {html}");
            assert_eq!(html, console_payroll_ui::render_shell(), "{uri}");
            assert_ui_invariants(&html);

            let (status, html) = get_ui_path(service.clone(), uri, Some(&member_tok)).await;
            assert_eq!(status, StatusCode::OK, "MEMBER {uri} {html}");
            assert_eq!(html, console_payroll_ui::render_shell(), "{uri}");
            assert!(!html.contains(&run_id), "MEMBER saw run at {uri}: {html}");
            assert_ui_invariants(&html);
        }

        let (status, admin_org) =
            get_ui_path(service.clone(), "/organization", Some(&admin_tok)).await;
        assert_eq!(status, StatusCode::OK, "{admin_org}");
        assert_eq!(
            admin_org,
            console_payroll_ui::render_shell(),
            "ADMIN without org-wide EmployeeDirectoryRead must omit Company/OrgUnit Heads: {admin_org}"
        );

        let (status, admin_hr) = get_ui_path(service.clone(), "/hr", Some(&admin_tok)).await;
        assert_eq!(status, StatusCode::OK, "{admin_hr}");
        assert_eq!(
            admin_hr,
            console_payroll_ui::render_shell(),
            "ADMIN without org-wide EmployeeDirectoryRead must omit Person/Employment Heads: {admin_hr}"
        );

        let (status, admin_pay) = get_ui_path(service.clone(), "/payroll", Some(&admin_tok)).await;
        assert_eq!(status, StatusCode::OK, "{admin_pay}");
        assert_eq!(
            admin_pay,
            console_payroll_ui::render_shell(),
            "ADMIN payroll route must deny-by-omission: {admin_pay}"
        );

        let (status, exec_home) = get_ui_path(service.clone(), "/", Some(&exec_tok)).await;
        assert_eq!(status, StatusCode::OK, "{exec_home}");
        assert!(
            exec_home.contains("data-screen=\"organization\"")
                && exec_home.contains("data-screen=\"hr\"")
                && exec_home.contains("data-screen=\"payroll\""),
            "EXECUTIVE home must mount every authorized body: {exec_home}"
        );
        assert!(
            exec_home.contains("href=\"/organization\"")
                && exec_home.contains("href=\"/hr\"")
                && exec_home.contains("href=\"/payroll\"")
                && exec_home.contains("조직")
                && exec_home.contains("인사")
                && exec_home.contains("급여"),
            "EXECUTIVE nav must expose authorized screens: {exec_home}"
        );
        assert!(
            exec_home.contains(&format!("data-org-id=\"{org_id}\""))
                && exec_home.contains(&format!("data-org-unit-id=\"{}\"", heads.org_unit_id))
                && exec_home.contains(&format!("data-person-id=\"{}\"", heads.person_id))
                && exec_home.contains(&format!("data-employment-id=\"{}\"", heads.employment_id))
                && exec_home.contains(&format!("data-run-id=\"{run_id}\""))
                && exec_home.contains("data-legal-name=")
                && exec_home.contains("data-display-name=")
                && exec_home.contains(&format!("href=\"/api/v1/companies/{org_id}\""))
                && exec_home.contains(&format!("href=\"/api/v1/org-units/{}\"", heads.org_unit_id))
                && exec_home.contains(&format!("href=\"/api/v1/persons/{}\"", heads.person_id))
                && exec_home.contains(&format!(
                    "href=\"/api/v1/employments/{}\"",
                    heads.employment_id
                ))
                && !exec_home.contains("data-slug")
                && !exec_home.contains("data-employee-"),
            "EXECUTIVE markup must carry published Head identifiers: {exec_home}"
        );
        assert!(
            exec_home.contains("/pkg/console_payroll_ui.js") && exec_home.contains("charset"),
            "payroll island hydrates via committed WASM; charset stays SSR: {exec_home}"
        );
        assert_ui_invariants(&exec_home);

        let (status, exec_org) =
            get_ui_path(service.clone(), "/organization", Some(&exec_tok)).await;
        assert_eq!(status, StatusCode::OK, "{exec_org}");
        assert!(
            exec_org.contains("data-screen=\"organization\"")
                && !exec_org.contains("data-screen=\"payroll\"")
                && !exec_org.contains("/pkg/")
                && exec_org.contains("href=\"/hr\"")
                && exec_org.contains("href=\"/payroll\""),
            "focused org keeps authorized nav and omits payroll WASM: {exec_org}"
        );
        assert_ui_invariants(&exec_org);

        let (status, exec_hr) = get_ui_path(service.clone(), "/hr", Some(&exec_tok)).await;
        assert_eq!(status, StatusCode::OK, "{exec_hr}");
        assert!(
            exec_hr.contains("data-screen=\"hr\"")
                && exec_hr.contains(&format!("data-person-id=\"{}\"", heads.person_id))
                && exec_hr.contains(&format!("data-employment-id=\"{}\"", heads.employment_id))
                && exec_hr.contains("data-legal-name=")
                && exec_hr.contains("data-appointed-on=")
                && !exec_hr.contains("data-employee-")
                && !exec_hr.contains("/api/v1/job-positions/")
                && !exec_hr.contains("/pkg/"),
            "EXECUTIVE HR is SSR Person+Employment Head, not an island: {exec_hr}"
        );
        assert_ui_invariants(&exec_hr);

        let (status, exec_pay) = get_ui_path(service.clone(), "/payroll", Some(&exec_tok)).await;
        assert_eq!(status, StatusCode::OK, "{exec_pay}");
        assert!(
            exec_pay.contains("data-screen=\"payroll\"")
                && exec_pay.contains(&format!("data-run-id=\"{run_id}\""))
                && exec_pay.contains("href=\"/organization\"")
                && exec_pay.contains("href=\"/hr\""),
            "focused payroll stays reachable from org/HR nav: {exec_pay}"
        );
        assert!(
            !exec_pay.contains("method=\"post\""),
            "shipping screens are read projections; UI mutations stay HOLD: {exec_pay}"
        );
        assert_ui_invariants(&exec_pay);

        let exec_audits = list_read_audits(&pool, executive).await;
        assert!(
            exec_audits > 0,
            "EXECUTIVE payroll listing must write payroll_run.list_read (got {exec_audits})"
        );
        assert_eq!(
            list_read_audits(&pool, member).await,
            0,
            "MEMBER must not audit a payroll list read they cannot perform"
        );
        assert_eq!(
            list_read_audits(&pool, admin).await,
            0,
            "ADMIN without org-wide PayrollRunRead must not audit payroll list reads"
        );

        let (status, foreign_html) = get_ui_path(service.clone(), "/", Some(&foreign_tok)).await;
        assert_eq!(status, StatusCode::OK, "{foreign_html}");
        assert!(
            !foreign_html.contains(&run_id) && !foreign_html.contains(&org_id),
            "other-org SUPER_ADMIN must not see KNL identifiers: {foreign_html}"
        );
        assert_ui_invariants(&foreign_html);

        let (status, super_html) = get_ui_path(service.clone(), "/", Some(&super_tok)).await;
        assert_eq!(status, StatusCode::OK, "{super_html}");
        assert!(
            super_html.contains(&format!("data-run-id=\"{run_id}\""))
                && super_html.contains("data-screen=\"organization\"")
                && super_html.contains("data-screen=\"hr\""),
            "SUPER_ADMIN must see the same authorized contract rows: {super_html}"
        );
        assert_ui_invariants(&super_html);
    }
}
