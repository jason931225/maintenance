import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ko } from "../../i18n/ko";
import { PolicyGateProvider, type PolicyGate } from "../policy";
import { WindowManagerProvider } from "../window";
import { OntologyManagerScreen } from "./OntologyManagerScreen";
import type { OntologyManagerStrings } from "./strings";
import type { OntObjectTypeDef } from "./types";

// Mirror of the ko.console.ontology manifest (applied by the serial i18n
// wire-up). ??= keeps the real ko.ts keys authoritative once they land; until
// then this makes the screen renderable standalone.
const KO_CONSOLE_ONTOLOGY: OntologyManagerStrings = {
  typeList: {
    title: "타입",
    rowAria: (code: string, title: string) => `${code} ${title} 타입 편집`,
    addName: "새 타입 이름",
    addSubmit: "타입 추가",
  },
  stage: {
    draft: "초안",
    review_pending: "검토 대기",
    published: "게시됨",
    superseded: "대체됨",
    retired: "폐기됨",
  },
  version: (version: number) => `v${String(version)}`,
  stagedVersion: (version: number) => `v${String(version)} 스테이징`,
  backing: { projected: "투영", instance: "인스턴스" },
  instanceCount: (count: number) => `개체 ${String(count)}`,
  count: (count: number) => `${String(count)}개`,
  staging: {
    pending: "개정 대기",
    fourEyes: "이중 승인",
    approve: "적용 승인",
    discard: "철회",
  },
  subtabsAria: "타입 편집 탭",
  subtabs: {
    properties: "속성",
    links: "관계",
    actions: "액션",
    analytics: "분석",
    instances: "인스턴스",
    automations: "자동화",
  },
  fieldKind: {
    text: "텍스트",
    number: "숫자",
    money: "금액",
    date: "날짜",
    datetime: "일시",
    boolean: "예/아니오",
    choice: "선택",
    user: "사용자",
    object_ref: "개체 참조",
    attachment: "첨부",
  },
  cardinality: { one_one: "1:1", one_many: "1:N", many_one: "N:1", many_many: "N:N" },
  dispatch: { projected_usecase: "도메인 유스케이스", instance_revision: "인스턴스 리비전" },
  properties: {
    required: "필수",
    policy: "속성 정책",
    addName: "속성 이름",
    addType: "데이터 타입",
    addSubmit: "속성 추가",
  },
  links: {
    addName: "관계 이름",
    addTarget: "대상 타입",
    addCardinality: "카디널리티",
    addSubmit: "관계 추가",
  },
  actionEditor: {
    addName: "액션 이름",
    addDispatch: "디스패치",
    addSubmit: "액션 추가",
  },
  analyticEditor: {
    addName: "분석 이름",
    addFormula: "수식",
    addSubmit: "분석 추가",
  },
  instances: {
    rowAria: (code: string) => `${code} 개체 카드 열기`,
  },
  empty: "없음",
  samples: {
    types: { workOrder: "작업지시", equipment: "설비", memo: "안전 점검 메모" },
    props: {
      title: "제목",
      priority: "우선순위",
      assignee: "담당자",
      due: "완료 기한",
      cost: "예상 비용",
      model: "모델명",
      commissioned: "도입일",
      body: "내용",
    },
    links: { equipment: "대상 장비", workOrders: "관련 작업지시" },
    actions: { reassign: "재배정", complete: "완료 처리" },
    analytics: { delayDays: "지연 일수" },
    instances: {
      wo2643: "4호기 유압 점검",
      wo2650: "컨베이어 벨트 교체",
      eq118: "5호기 지게차",
    },
  },
};

(ko.console as unknown as Record<string, unknown>).ontology ??= KO_CONSOLE_ONTOLOGY;

const allowGate: PolicyGate = { can: () => true };
const denyGate: PolicyGate = { can: () => false };

// Injected registry fixture — the screen is API-fed (OntologyPage passes the
// mapped GET /ontology/object-types payload); this mirrors that mapped shape.
function registryFixture(): OntObjectTypeDef[] {
  return [
    {
      id: "work_order",
      stableKey: "work_order",
      code: "OT-01",
      title: "작업지시",
      backingKind: "projected",
      schemaVersion: 2,
      lifecycleState: "published",
      properties: [
        { key: "title", title: "제목", type: "text", required: true },
        { key: "priority", title: "우선순위", type: "choice", required: true },
        { key: "assignee", title: "담당자", type: "user", required: false },
        { key: "due_date", title: "완료 기한", type: "date", required: false },
        { key: "cost", title: "예상 비용", type: "money", required: false, inPropertyPolicy: true },
      ],
      links: [
        { stableKey: "wo_equipment", title: "대상 장비", toTypeKey: "equipment", cardinality: "one_many" },
      ],
      actions: [
        { stableKey: "reassign", title: "재배정", dispatch: "projected_usecase" },
        { stableKey: "complete", title: "완료 처리", dispatch: "projected_usecase" },
      ],
      analytics: [
        { key: "delay_days", title: "지연 일수", formula: "days_between(due_date, now())" },
      ],
      instances: [
        { id: "wo-2643", code: "WO-2643", title: "4호기 유압 점검", lifecycleState: "active" },
        { id: "wo-2650", code: "WO-2650", title: "컨베이어 벨트 교체", lifecycleState: "draft" },
      ],
      acting: [
        { id: "wf-1", label: "wf-wo-review", kind: "automation" },
        { id: "pol-1", label: "pbac-wo-edit", kind: "policy" },
      ],
    },
    {
      id: "equipment",
      stableKey: "equipment",
      code: "OT-02",
      title: "설비",
      backingKind: "projected",
      schemaVersion: 1,
      lifecycleState: "published",
      properties: [
        { key: "model", title: "모델명", type: "text", required: true },
      ],
      links: [],
      actions: [],
      analytics: [],
      instances: [
        { id: "eq-118", code: "EQ-118", title: "5호기 지게차", lifecycleState: "active" },
      ],
      acting: [],
    },
    {
      id: "safety_memo",
      stableKey: "safety_memo",
      code: "OT-03",
      title: "안전 점검 메모",
      backingKind: "instance",
      schemaVersion: 1,
      lifecycleState: "draft",
      properties: [{ key: "body", title: "내용", type: "text", required: true }],
      links: [],
      actions: [],
      analytics: [],
      instances: [],
      acting: [],
    },
  ];
}

function renderScreen(gate: PolicyGate = allowGate) {
  return render(
    <PolicyGateProvider gate={gate}>
      <WindowManagerProvider>
        <OntologyManagerScreen registry={registryFixture()} />
      </WindowManagerProvider>
    </PolicyGateProvider>,
  );
}

function editor(name: string): HTMLElement {
  return screen.getByRole("article", { name });
}

describe("OntologyManagerScreen (design change-log 63)", () => {
  it("lists types with stage · version · instance-count chips and opens the first type", () => {
    renderScreen();
    const row = screen.getByRole("button", { name: "OT-01 작업지시 타입 편집" });
    expect(within(row).getByText("게시됨")).toBeVisible();
    expect(within(row).getByText("v2")).toBeVisible();
    expect(within(row).getByText("개체 2")).toBeVisible();

    const panel = editor("작업지시");
    expect(within(panel).getByText("우선순위")).toBeVisible();
    // property-policy field carries its chip (deny-by-omission is server-side).
    expect(within(panel).getByText("속성 정책")).toBeVisible();
    expect(within(panel).getByText("투영")).toBeVisible();
  });

  it("switches between the six editor subtabs", () => {
    renderScreen();
    const panel = editor("작업지시");
    fireEvent.click(within(panel).getByRole("tab", { name: "관계" }));
    const linkRow = within(panel).getByText("대상 장비").closest("li");
    expect(linkRow).not.toBeNull();
    expect(within(linkRow as HTMLElement).getByText("1:N")).toBeVisible();

    fireEvent.click(within(panel).getByRole("tab", { name: "액션" }));
    expect(within(panel).getByText("재배정")).toBeVisible();

    fireEvent.click(within(panel).getByRole("tab", { name: "분석" }));
    expect(within(panel).getByText("days_between(due_date, now())")).toBeVisible();

    fireEvent.click(within(panel).getByRole("tab", { name: "자동화" }));
    expect(within(panel).getByText("wf-wo-review")).toBeVisible();
  });

  it("stages a v+1 revision when a published type is edited, then commits on 적용 승인", () => {
    renderScreen();
    const panel = editor("작업지시");
    fireEvent.change(within(panel).getByLabelText("속성 이름"), { target: { value: "예산 코드" } });
    fireEvent.click(within(panel).getByRole("button", { name: "속성 추가" }));

    const banner = within(panel).getByRole("status", { name: "개정 대기" });
    expect(within(banner).getByText("v3 스테이징")).toBeVisible();
    expect(within(panel).getByText("예산 코드")).toBeVisible();
    // committed header version is untouched while staged.
    expect(within(panel).getByText("v2")).toBeVisible();

    fireEvent.click(within(banner).getByRole("button", { name: "적용 승인" }));
    expect(within(panel).queryByRole("status", { name: "개정 대기" })).toBeNull();
    expect(within(panel).getByText("v3")).toBeVisible();
    expect(within(panel).getByText("예산 코드")).toBeVisible();
  });

  it("철회 drops the staged revision and restores the committed schema", () => {
    renderScreen();
    const panel = editor("작업지시");
    fireEvent.change(within(panel).getByLabelText("속성 이름"), { target: { value: "예산 코드" } });
    fireEvent.click(within(panel).getByRole("button", { name: "속성 추가" }));
    fireEvent.click(within(panel).getByRole("button", { name: "철회" }));

    expect(within(panel).queryByRole("status", { name: "개정 대기" })).toBeNull();
    expect(within(panel).queryByText("예산 코드")).toBeNull();
    expect(within(panel).getByText("v2")).toBeVisible();
  });

  it("edits draft types direct — no staging banner, no version bump", () => {
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "OT-03 안전 점검 메모 타입 편집" }));
    const panel = editor("안전 점검 메모");
    fireEvent.change(within(panel).getByLabelText("속성 이름"), { target: { value: "점검자" } });
    fireEvent.click(within(panel).getByRole("button", { name: "속성 추가" }));

    expect(within(panel).queryByRole("status", { name: "개정 대기" })).toBeNull();
    expect(within(panel).getByText("점검자")).toBeVisible();
    expect(within(panel).getByText("v1")).toBeVisible();
  });

  it("adds a relation with target type and cardinality from the typed selects", () => {
    renderScreen();
    const panel = editor("작업지시");
    fireEvent.click(within(panel).getByRole("tab", { name: "관계" }));
    fireEvent.change(within(panel).getByLabelText("관계 이름"), { target: { value: "점검 메모" } });
    fireEvent.change(within(panel).getByLabelText("대상 타입"), { target: { value: "safety_memo" } });
    fireEvent.change(within(panel).getByLabelText("카디널리티"), { target: { value: "many_many" } });
    fireEvent.click(within(panel).getByRole("button", { name: "관계 추가" }));

    expect(within(panel).getByRole("status", { name: "개정 대기" })).toBeVisible();
    const row = within(panel).getByText("점검 메모").closest("li");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("N:N")).toBeVisible();
    expect(within(row as HTMLElement).getByText("OT-03")).toBeVisible();
  });

  it("opens an instance row as the right pin ObjectCard (§4.7-3)", () => {
    renderScreen();
    const panel = editor("작업지시");
    fireEvent.click(within(panel).getByRole("tab", { name: "인스턴스" }));
    const row = within(panel).getByRole("button", { name: "WO-2643 개체 카드 열기" });
    expect(row).toHaveAttribute("draggable", "true");
    fireEvent.click(row);

    const pin = screen.getByRole("region", { name: "4호기 유압 점검" });
    expect(pin).toBeVisible();
    expect(within(pin).getByText("WO-2643")).toBeVisible();
  });

  it("creates a draft type via the inline add path and selects it", () => {
    renderScreen();
    fireEvent.change(screen.getByLabelText("새 타입 이름"), { target: { value: "구매 요청" } });
    fireEvent.click(screen.getByRole("button", { name: "타입 추가" }));

    const row = screen.getByRole("button", { name: "OT-04 구매 요청 타입 편집" });
    expect(row).toHaveAttribute("aria-current", "true");
    const panel = editor("구매 요청");
    expect(within(panel).getByText("초안")).toBeVisible();
  });

  it("deny-by-omission: mutation and drill affordances are absent under a deny gate", () => {
    renderScreen(denyGate);
    expect(screen.queryByLabelText("새 타입 이름")).toBeNull();
    const panel = editor("작업지시");
    expect(within(panel).queryByLabelText("속성 이름")).toBeNull();

    fireEvent.click(within(panel).getByRole("tab", { name: "인스턴스" }));
    // rows degrade to non-interactive (still draggable) pills.
    expect(within(panel).queryByRole("button", { name: "WO-2643 개체 카드 열기" })).toBeNull();
    expect(within(panel).getByText("WO-2643")).toBeVisible();
  });
});
