import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type SyntheticEvent,
} from "react";

import type { components } from "@maintenance/api-client-ts";

import { useAuth } from "../../../context/auth";
import {
  DENY_ALL_PROJECTION,
  fetchAuthzProjection,
  gateAllows,
  type AuthzProjection,
} from "../../policy/authz";
import "../../tokens.css";

type BenefitItem = components["schemas"]["BenefitCatalogItem"];
type BenefitPage = components["schemas"]["BenefitCatalogItemPage"];
type BenefitCatalogCreateRequest =
  components["schemas"]["BenefitCatalogCreateRequest"];
type BenefitCatalogTier = components["schemas"]["BenefitCatalogTier"];
type BenefitCatalogCondition = components["schemas"]["BenefitCatalogCondition"];

type EditorValues = {
  category: "legal" | "extra";
  name: string;
  coverageLabel: string;
  costLabel: string;
  tierBasis: string;
  tierKey: string;
  tierValue: string;
  conditionKey: string;
  conditionLabel: string;
  conditionValue: string;
};

const pageStyle: CSSProperties = {
  height: "100%",
  overflowY: "auto",
  padding: "var(--sp-6)",
  background: "var(--canvas)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
};
const panelStyle: CSSProperties = {
  border: "var(--border-hairline)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
};
const chipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 26,
  padding: "0 var(--sp-2)",
  borderRadius: 999,
  border: "1px solid var(--border)",
  background: "var(--muted)",
  fontSize: "var(--text-caption)",
  whiteSpace: "nowrap",
};
const buttonStyle: CSSProperties = {
  minHeight: 40,
  padding: "0 var(--sp-3)",
  border: "1px solid var(--accent)",
  borderRadius: "var(--radius-sm)",
  background: "var(--accent)",
  color: "var(--on-accent)",
  font: "inherit",
  cursor: "pointer",
};
const fieldStyle: CSSProperties = {
  minHeight: 40,
  width: "100%",
  boxSizing: "border-box",
  border: "var(--border-hairline)",
  borderRadius: "var(--radius-sm)",
  background: "var(--surface)",
  color: "var(--ink)",
  font: "inherit",
  padding: "0 var(--sp-2)",
};

function errorMessage(
  error: unknown,
  fallback = "복리후생 요청을 처리하지 못했습니다.",
): string {
  if (error && typeof error === "object" && "error" in error) {
    const nested = (error as { error?: { message?: unknown } }).error;
    if (typeof nested?.message === "string" && nested.message.trim())
      return nested.message;
  }
  return fallback;
}

function nextState(state: string | null | undefined): string | undefined {
  return (
    {
      draft: "pending",
      pending: "finalized",
      finalized: "implemented",
      implemented: "retiring",
      retiring: "retired",
    } as const
  )[state ?? ""];
}

function lifecycleLabel(state: string | null | undefined): string {
  return (
    (
      {
        draft: "초안",
        pending: "승인 대기",
        finalized: "시행 예정",
        implemented: "시행 중",
        retiring: "폐지 예정",
        retired: "폐지됨",
      } as Record<string, string>
    )[state ?? ""] ?? "상태 미등록"
  );
}

function scopeLabel(item: BenefitItem): string {
  if (item.scope.site_id) return "사업장 적용";
  if (item.scope.branch_id) return "법인 적용";
  return item.scope.scope_type === "ORG"
    ? "전사 적용"
    : `${item.scope.scope_type} 적용`;
}

function editorValues(
  item?: BenefitItem,
  category: "legal" | "extra" = "legal",
): EditorValues {
  const tier = item?.tiers[0];
  const condition = item?.conditions[0];
  return {
    category: item?.category ?? category,
    name: item?.name ?? "",
    coverageLabel: item?.coverage_label ?? "",
    costLabel: item?.cost_label ?? "",
    tierBasis: tier?.tier_basis ?? "적용 기준",
    tierKey: tier?.tier_key ?? "전체",
    tierValue: tier?.value_label ?? "",
    conditionKey: condition?.condition_key ?? "employee",
    conditionLabel: condition?.display_label ?? "전사 적용",
    conditionValue: conditionValueText(condition?.condition_value),
  };
}

function conditionValueText(
  value: Record<string, unknown> | undefined,
): string {
  const candidate = value?.value;
  return typeof candidate === "string" ? candidate : "전체";
}

function tiers(values: EditorValues): BenefitCatalogTier[] {
  return [
    {
      tier_basis: values.tierBasis.trim(),
      tier_key: values.tierKey.trim(),
      value_label: values.tierValue.trim(),
      amount_won: null,
      limit_period: null,
      criteria: {},
      display_order: 0,
    },
  ];
}

function conditions(values: EditorValues): BenefitCatalogCondition[] {
  return [
    {
      condition_kind: "ORG",
      operator: "exists",
      condition_key: values.conditionKey.trim(),
      condition_value: { value: values.conditionValue.trim() },
      display_label: values.conditionLabel.trim(),
      cedar_policy_ref: null,
      display_order: 0,
    },
  ];
}

function valid(values: EditorValues, includesChildren: boolean): string | undefined {
  if (
    !values.name.trim() ||
    !values.coverageLabel.trim() ||
    !values.costLabel.trim()
  )
    return "정책명, 적용 범위, 비용 설명은 필수입니다.";
  if (
    includesChildren &&
    (!values.tierBasis.trim() ||
      !values.tierKey.trim() ||
      !values.tierValue.trim())
  )
    return "등급의 기준, 키, 설명은 필수입니다.";
  if (
    includesChildren &&
    (!values.conditionKey.trim() || !values.conditionLabel.trim())
  )
    return "적격성 키와 설명은 필수입니다.";
  if (includesChildren && !values.conditionValue.trim())
    return "적격성 값은 필수입니다.";
  return undefined;
}

function CatalogEditor({
  item,
  category,
  busy,
  onCancel,
  onSubmit,
}: {
  item?: BenefitItem;
  category: "legal" | "extra";
  busy: boolean;
  onCancel: () => void;
  onSubmit: (values: EditorValues) => Promise<void>;
}) {
  const [values, setValues] = useState(() => editorValues(item, category));
  const [validation, setValidation] = useState<string>();
  const update = <K extends keyof EditorValues>(
    key: K,
    value: EditorValues[K],
  ) => {
    setValues((current) => ({ ...current, [key]: value }));
  };
  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = valid(values, !item);
    if (message) {
      setValidation(message);
      return;
    }
    setValidation(undefined);
    await onSubmit(values);
  };
  return (
    <form
      aria-label={item ? "복리후생 정책 수정" : "복리후생 정책 등록"}
      onSubmit={(event) => {
        void submit(event);
      }}
      style={{
        ...panelStyle,
        padding: "var(--sp-4)",
        display: "grid",
        gap: "var(--sp-3)",
        marginBottom: "var(--sp-4)",
      }}
    >
      <div>
        <h2 style={{ margin: 0, fontSize: "var(--text-body)" }}>
          {item ? "복리후생 정책 수정" : "새 복리후생 정책 등록"}
        </h2>
      </div>
      {validation ? (
        <p role="alert" style={{ margin: 0, color: "var(--danger)" }}>
          {validation}
        </p>
      ) : null}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "var(--sp-3)",
        }}
      >
        <label>
          분류
          <select
            aria-label="분류"
            value={values.category}
            onChange={(event) => {
              update(
                "category",
                event.target.value as EditorValues["category"],
              );
            }}
            style={fieldStyle}
          >
            <option value="legal">법정</option>
            <option value="extra">선택</option>
          </select>
        </label>
        <label>
          정책명
          <input
            value={values.name}
            onChange={(event) => {
              update("name", event.target.value);
            }}
            style={fieldStyle}
          />
        </label>
        <label>
          적용 범위 설명
          <input
            value={values.coverageLabel}
            onChange={(event) => {
              update("coverageLabel", event.target.value);
            }}
            style={fieldStyle}
          />
        </label>
        <label>
          비용 설명
          <input
            value={values.costLabel}
            onChange={(event) => {
              update("costLabel", event.target.value);
            }}
            style={fieldStyle}
          />
        </label>
        {!item ? (
          <>
            <label>
              등급 기준
              <input
                value={values.tierBasis}
                onChange={(event) => {
                  update("tierBasis", event.target.value);
                }}
                style={fieldStyle}
              />
            </label>
            <label>
              등급 키
              <input
                value={values.tierKey}
                onChange={(event) => {
                  update("tierKey", event.target.value);
                }}
                style={fieldStyle}
              />
            </label>
            <label>
              등급 설명
              <input
                value={values.tierValue}
                onChange={(event) => {
                  update("tierValue", event.target.value);
                }}
                style={fieldStyle}
              />
            </label>
            <label>
              적격성 키
              <input
                value={values.conditionKey}
                onChange={(event) => {
                  update("conditionKey", event.target.value);
                }}
                style={fieldStyle}
              />
            </label>
            <label>
              적격성 설명
              <input
                value={values.conditionLabel}
                onChange={(event) => {
                  update("conditionLabel", event.target.value);
                }}
                style={fieldStyle}
              />
            </label>
          </>
        ) : null}
      </div>
      {!item ? (
        <label>
          적격성 값
          <input
            value={values.conditionValue}
            onChange={(event) => {
              update("conditionValue", event.target.value);
            }}
            style={fieldStyle}
          />
        </label>
      ) : null}
      <div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap" }}>
        <button type="submit" disabled={busy} style={buttonStyle}>
          {busy ? "저장 중…" : item ? "변경 저장" : "정책 등록"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          style={{
            ...buttonStyle,
            background: "var(--surface)",
            color: "var(--ink)",
            border: "var(--border-hairline)",
          }}
        >
          취소
        </button>
      </div>
    </form>
  );
}

export function BenefitBody() {
  const { api, session } = useAuth();
  const authority = api;
  const [category, setCategory] = useState<"legal" | "extra">("legal");
  const [page, setPage] = useState<BenefitPage>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [advancing, setAdvancing] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<BenefitItem | "new">();
  const [projection, setProjection] =
    useState<AuthzProjection>(DENY_ALL_PROJECTION);
  const [authzReady, setAuthzReady] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    const result = await authority
      .GET("/api/v1/benefit-catalog/items", {
        params: { query: { category, limit: 50, offset: 0 } },
      })
      .catch(() => undefined);
    if (!result?.data) {
      setPage(undefined);
      setError(
        errorMessage(result?.error, "복리후생 목록을 불러오지 못했습니다."),
      );
      setLoading(false);
      return;
    }
    setPage(result.data);
    setLoading(false);
  }, [authority, category]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useEffect(() => {
    const controller = new AbortController();
    void fetchAuthzProjection(session?.access_token, controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return;
        setProjection(next ?? DENY_ALL_PROJECTION);
        setAuthzReady(true);
      },
    );
    return () => {
      controller.abort();
    };
  }, [session?.access_token]);

  const annualCost = useMemo(
    () =>
      page?.items.reduce(
        (total, item) => total + (item.estimated_annual_cost_won ?? 0),
        0,
      ) ?? 0,
    [page],
  );
  const canAdvanceLifecycle =
    authzReady && gateAllows(projection, { feature: "lifecycle_manage" });
  const canManage =
    authzReady && gateAllows(projection, { feature: "benefit_catalog_manage" });
  const advance = useCallback(
    async (item: BenefitItem) => {
      const to_state = nextState(item.lifecycle.current_state);
      if (!to_state || item.lifecycle.legal_hold) return;
      setAdvancing(item.id);
      const result = await authority
        .POST("/api/v1/lifecycles/{objectType}/{objectId}/transition", {
          params: {
            path: {
              objectType: item.lifecycle.object_type,
              objectId: item.lifecycle.object_id,
            },
          },
          body: {
            toState: to_state,
            reason: `benefit_catalog:${item.benefit_code}`,
          },
        })
        .catch(() => undefined);
      setAdvancing(undefined);
      if (!result?.data) {
        setError(errorMessage(result?.error));
        return;
      }
      await load();
    },
    [authority, load],
  );
  const save = useCallback(
    async (values: EditorValues) => {
      setSaving(true);
      setError(undefined);
      let result: { data?: BenefitItem; error?: unknown } | undefined;
      if (editing === "new") {
        const body: BenefitCatalogCreateRequest = {
          scope: { scope_type: "ORG" },
          category: values.category,
          name: values.name.trim(),
          coverageLabel: values.coverageLabel.trim(),
          costLabel: values.costLabel.trim(),
          displayOrder: 0,
          metadata: {},
          tiers: tiers(values),
          conditions: conditions(values),
        };
        result = await authority
          .POST("/api/v1/benefit-catalog/items", { body })
          .catch(() => undefined);
      } else if (editing) {
        result = await authority
          .PATCH("/api/v1/benefit-catalog/items/{benefit_id}", {
            params: { path: { benefit_id: editing.id } },
            body: {
              category: values.category,
              name: values.name.trim(),
              coverageLabel: values.coverageLabel.trim(),
              costLabel: values.costLabel.trim(),
            },
          })
          .catch(() => undefined);
      }
      setSaving(false);
      if (!result?.data) {
        setError(errorMessage(result?.error));
        return;
      }
      setEditing(undefined);
      await load();
    },
    [authority, editing, load],
  );

  return (
    <section aria-label="복리후생" style={pageStyle}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: "var(--sp-4)",
          alignItems: "start",
          marginBottom: "var(--sp-5)",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1
            style={{
              margin: 0,
              fontSize: "var(--text-title)",
              letterSpacing: "-0.02em",
            }}
          >
            복리후생
          </h1>
        </div>
        <div
          style={{
            display: "flex",
            gap: "var(--sp-2)",
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <span style={chipStyle}>{page?.total ?? 0}개 정책</span>
          {annualCost > 0 ? (
            <span style={chipStyle}>
              연 ₩{annualCost.toLocaleString("ko-KR")}
            </span>
          ) : null}
          {canManage ? (
            <button
              onClick={() => {
                setEditing("new");
              }}
              style={buttonStyle}
            >
              정책 등록
            </button>
          ) : null}
        </div>
      </header>
      <div
        role="tablist"
        aria-label="복리후생 분류"
        style={{
          display: "flex",
          gap: "var(--sp-2)",
          marginBottom: "var(--sp-4)",
        }}
      >
        {(
          [
            ["legal", "법정"],
            ["extra", "선택"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            role="tab"
            aria-selected={category === value}
            onClick={() => {
              setCategory(value);
            }}
            style={{
              minHeight: 40,
              padding: "0 var(--sp-4)",
              cursor: "pointer",
              border:
                category === value
                  ? "1px solid var(--accent)"
                  : "var(--border-hairline)",
              borderRadius: "var(--radius-sm)",
              background:
                category === value ? "var(--accent-soft)" : "var(--surface)",
              color: "var(--ink)",
              font: "inherit",
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {editing ? (
        <CatalogEditor
          item={editing === "new" ? undefined : editing}
          category={category}
          busy={saving}
          onCancel={() => {
            setEditing(undefined);
          }}
          onSubmit={save}
        />
      ) : null}
      {loading ? (
        <div style={{ ...panelStyle, padding: "var(--sp-5)" }} role="status">
          복리후생 정책을 불러오는 중…
        </div>
      ) : null}
      {error ? (
        <div
          style={{
            ...panelStyle,
            padding: "var(--sp-5)",
            display: "grid",
            gap: "var(--sp-3)",
            justifyItems: "start",
          }}
          role="alert"
        >
          <span>{error}</span>
          <button
            onClick={() => {
              void load();
            }}
            style={{
              ...buttonStyle,
              background: "var(--muted)",
              color: "var(--ink)",
              border: "var(--border-hairline)",
            }}
          >
            다시 시도
          </button>
        </div>
      ) : null}
      {!loading && !error && page?.items.length === 0 ? (
        <div style={{ ...panelStyle, padding: "var(--sp-6)" }} role="status">
          이 분류에 등록된 복리후생 정책이 없습니다.
        </div>
      ) : null}
      {!loading && !error && page?.items.length ? (
        <div style={{ display: "grid", gap: "var(--sp-3)" }}>
          {page.items.map((item) => {
            const next = nextState(item.lifecycle.current_state);
            return (
              <article
                key={item.id}
                style={{
                  ...panelStyle,
                  padding: "var(--sp-4)",
                  display: "grid",
                  gap: "var(--sp-3)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "var(--sp-3)",
                    flexWrap: "wrap",
                  }}
                >
                  <div>
                    <div
                      style={{
                        display: "flex",
                        gap: "var(--sp-2)",
                        alignItems: "center",
                        flexWrap: "wrap",
                      }}
                    >
                      <strong style={{ fontSize: "var(--text-body)" }}>
                        {item.name}
                      </strong>
                      <code
                        style={{
                          color: "var(--ink-muted)",
                          fontSize: "var(--text-caption)",
                        }}
                      >
                        {item.benefit_code}
                      </code>
                      <span style={chipStyle}>
                        {lifecycleLabel(item.lifecycle.current_state)}
                      </span>
                    </div>
                    <div
                      style={{
                        marginTop: "var(--sp-1)",
                        color: "var(--ink-muted)",
                        fontSize: "var(--text-caption)",
                      }}
                    >
                      {scopeLabel(item)} · {item.coverage_label} ·{" "}
                      {item.cost_label}
                    </div>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: "var(--sp-2)",
                      flexWrap: "wrap",
                    }}
                  >
                    {canManage ? (
                      <button
                        onClick={() => {
                          setEditing(item);
                        }}
                        style={{
                          ...buttonStyle,
                          background: "var(--surface)",
                          color: "var(--ink)",
                          border: "var(--border-hairline)",
                        }}
                      >
                        정책 수정
                      </button>
                    ) : null}
                    {canAdvanceLifecycle &&
                    next &&
                    !item.lifecycle.legal_hold ? (
                      <button
                        aria-label="다음 상태"
                        disabled={advancing === item.id}
                        onClick={() => {
                          void advance(item);
                        }}
                        style={buttonStyle}
                      >
                        {advancing === item.id ? "처리 중…" : "다음 상태"}
                      </button>
                    ) : null}
                  </div>
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                    gap: "var(--sp-3)",
                    borderTop: "var(--border-hairline)",
                    paddingTop: "var(--sp-3)",
                  }}
                >
                  <div>
                    <b style={{ fontSize: "var(--text-caption)" }}>적격성</b>
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: "var(--sp-1)",
                        marginTop: "var(--sp-1)",
                      }}
                    >
                      {item.conditions.length ? (
                        item.conditions.map((condition) => (
                          <span key={condition.id} style={chipStyle}>
                            {condition.display_label}
                          </span>
                        ))
                      ) : (
                        <span
                          style={{
                            color: "var(--ink-muted)",
                            fontSize: "var(--text-caption)",
                          }}
                        >
                          등록된 조건 없음
                        </span>
                      )}
                    </div>
                  </div>
                  <div>
                    <b style={{ fontSize: "var(--text-caption)" }}>등급</b>
                    <div
                      style={{
                        display: "grid",
                        gap: "var(--sp-1)",
                        marginTop: "var(--sp-1)",
                      }}
                    >
                      {item.tiers.length ? (
                        item.tiers.map((tier) => (
                          <span
                            key={tier.id}
                            style={{ fontSize: "var(--text-caption)" }}
                          >
                            <b>
                              {tier.tier_basis} · {tier.tier_key}
                            </b>{" "}
                            · {tier.value_label}
                          </span>
                        ))
                      ) : (
                        <span
                          style={{
                            color: "var(--ink-muted)",
                            fontSize: "var(--text-caption)",
                          }}
                        >
                          등록된 등급 없음
                        </span>
                      )}
                    </div>
                  </div>
                  <div>
                    <b style={{ fontSize: "var(--text-caption)" }}>근거·연결</b>
                    <div
                      style={{
                        marginTop: "var(--sp-1)",
                        color: "var(--ink-muted)",
                        fontSize: "var(--text-caption)",
                      }}
                    >
                      {item.legal_basis ?? item.note ?? "등록된 근거 없음"}
                      {item.related_domain ? ` · ${item.related_domain}` : ""}
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
