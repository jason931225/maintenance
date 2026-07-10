//! Governed console config object types, seeded THROUGH the ontology engine.
//!
//! The console's SLO settings (§4-26) and dashboard/table layouts (§19) are not
//! bespoke stores — they are ordinary `instance`-backed object types in the §18
//! registry, so they get lifecycle, revision staging (§3.9.0), fixity, RLS and
//! audit for free from the one engine. This module only builds the
//! [`CreateObjectTypeDraft`]s and drives them through the existing store
//! (`create_object_type` → publish), so a new tenant is provisioned with the
//! standard catalog via the same audited path a human authoring surface uses —
//! never raw INSERTs.
//!
//! Each type ships a generic `create` action (`instance_revision` dispatch) whose
//! `edits` copy each declared property from a same-named param. That is the path
//! the console's `/actions/{key}/execute` uses to create an instance (there is no
//! direct POST /instances) and, with `instance_id` supplied, to stage a v+1
//! revision.

use mnt_kernel_core::{TraceContext, UserId};
use mnt_ontology_domain::{ActionDispatch, BackingKind, SchemaLifecycleState};
use serde_json::json;
use time::OffsetDateTime;

use crate::{
    ActionTypeInput, CreateObjectTypeDraft, ObjectTypeSummary, PgOntologyError, PgOntologyStore,
    PropertyDefInput,
};

pub const SUPPORT_SLO_SETTING_KEY: &str = "support_slo_setting";
pub const CONSOLE_VIEW_KEY: &str = "console_view";

/// A required property backed by a stored field-type tag (§3c).
fn prop(key: &str, title: &str, field_type: &str, config: serde_json::Value) -> PropertyDefInput {
    PropertyDefInput {
        key: key.to_owned(),
        title: title.to_owned(),
        field_type: field_type.to_owned(),
        config,
        backing_column: None,
        required: true,
        in_property_policy: false,
    }
}

/// The generic `create` action: one edit per property, each pulled from a
/// same-named required param. Handles both create (no `instance_id`) and stage
/// v+1 (with `instance_id`) via the `instance_revision` writeback.
fn create_action(props: &[PropertyDefInput]) -> ActionTypeInput {
    let params_schema: serde_json::Map<String, serde_json::Value> = props
        .iter()
        .map(|p| (p.key.clone(), json!({ "required": p.required })))
        .collect();
    let edits: Vec<serde_json::Value> = props
        .iter()
        .map(|p| json!({ "property": p.key, "param": p.key }))
        .collect();
    ActionTypeInput {
        stable_key: "create".to_owned(),
        title: "저장".to_owned(),
        params_schema: serde_json::Value::Object(params_schema),
        edits: serde_json::Value::Array(edits),
        submission_criteria: json!([]),
        side_effects: json!([]),
        dispatch: ActionDispatch::InstanceRevision,
        dispatch_target: None,
        // Authority gate only; team-scope gating (§19 팀 배포) is opened as a
        // governance approval by the caller, not encoded on the action here.
        control_points: json!(["authority"]),
    }
}

/// §4-26 SLO setting: threshold/window/escalation per support ticket type.
#[must_use]
pub fn support_slo_setting_draft() -> CreateObjectTypeDraft {
    let properties = vec![
        prop(
            "ticket_type",
            "티켓 유형",
            "choice",
            json!({"choices": [
                {"id": "incident", "name": "장애"},
                {"id": "request", "name": "요청"},
                {"id": "change", "name": "변경"}
            ]}),
        ),
        prop("threshold_minutes", "임계(분)", "integer", json!({})),
        prop(
            "window",
            "적용 시간",
            "choice",
            json!({"choices": [
                {"id": "business_hours", "name": "업무시간"},
                {"id": "calendar", "name": "24x7"}
            ]}),
        ),
        prop("escalation_target", "에스컬레이션 대상", "text", json!({})),
    ];
    CreateObjectTypeDraft {
        stable_key: SUPPORT_SLO_SETTING_KEY.to_owned(),
        title: "SLO 설정".to_owned(),
        title_property_key: Some("ticket_type".to_owned()),
        backing_kind: BackingKind::Instance,
        backing_table: None,
        primary_key_property: None,
        actions: vec![create_action(&properties)],
        properties,
        links: Vec::new(),
        analytics: Vec::new(),
    }
}

/// §19 console_view: a persisted dashboard/table layout doc. `scope` distinguishes
/// a personal layout (direct save) from a team layout (deployed via approval).
#[must_use]
pub fn console_view_draft() -> CreateObjectTypeDraft {
    let properties = vec![
        prop("screen_key", "화면", "text", json!({})),
        prop("config", "레이아웃", "json", json!({})),
        prop(
            "scope",
            "범위",
            "choice",
            json!({"choices": [
                {"id": "personal", "name": "개인"},
                {"id": "team", "name": "팀"}
            ]}),
        ),
    ];
    CreateObjectTypeDraft {
        stable_key: CONSOLE_VIEW_KEY.to_owned(),
        title: "콘솔 뷰".to_owned(),
        title_property_key: Some("screen_key".to_owned()),
        backing_kind: BackingKind::Instance,
        backing_table: None,
        primary_key_property: None,
        actions: vec![create_action(&properties)],
        properties,
        links: Vec::new(),
        analytics: Vec::new(),
    }
}

/// Create + publish one draft through the engine, returning the published head.
async fn seed_published(
    store: &PgOntologyStore,
    actor: UserId,
    draft: CreateObjectTypeDraft,
    occurred_at: OffsetDateTime,
) -> Result<ObjectTypeSummary, PgOntologyError> {
    let created = store
        .create_object_type(actor, draft, TraceContext::generate(), occurred_at)
        .await?;
    // draft → published (protection off allows the direct publish).
    store
        .transition_lifecycle(
            actor,
            created.id,
            SchemaLifecycleState::Published,
            false,
            TraceContext::generate(),
            occurred_at,
        )
        .await
}

/// Provision the standard governed-config catalog for the org armed on the
/// current request context (`app.current_org`). Idempotency is the caller's
/// concern — a second call conflicts on the registry's one-draft / one-published
/// unique indexes.
pub async fn seed_governed_config_object_types(
    store: &PgOntologyStore,
    actor: UserId,
    occurred_at: OffsetDateTime,
) -> Result<Vec<ObjectTypeSummary>, PgOntologyError> {
    let slo = seed_published(store, actor, support_slo_setting_draft(), occurred_at).await?;
    let view = seed_published(store, actor, console_view_draft(), occurred_at).await?;
    Ok(vec![slo, view])
}
