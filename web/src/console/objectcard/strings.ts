// UI copy for the governed (wired) object-card panels. check-ui-strings forbids
// Hangul in lane files and this lane must not edit ko.ts — the serial i18n
// wire-up applies the koManifest below as ko.console.objectcardGov; until it
// lands these English defaults keep the surface mountable and testable.
//
// koManifest (proposed Korean for the wire-up):
//   gates:        authority "권한", selfChecklist "자가 점검", fourEyes "이중 승인", egressDlp "반출 검사"
//   gateStatus:   notRequired "해당 없음", satisfied "충족", pending "대기", denied "거부"
//   preflight:    title (t) => `${t} 사전 점검`, checking "점검 중", execute "실행",
//                 executing "실행 중", checklistAck "체크리스트 모두 확인", close "닫기"
//   executedToast (action, version, code) => `${action} 완료 · r${version} · ${code}`
//   override:     pendingTitle "오버라이드 대기", approve "적용 승인", reject "반려",
//                 requester (id) => `요청자 ${id}`, approvedChip "승인 완료", rejectedChip "반려됨"
//   lifecycle:    preflightTitle (s) => `${s} 전환 점검`, blocker "차단", warning "대기",
//                 notConfigured "전환 미구성(차단)", transition (s) => `${s}(으)로 전환`
//
// koManifest (ko.console.objectcardDyn — dynamic-layer additions):
//   relations: codeNotFound "해당 코드의 개체를 찾을 수 없습니다", resolveFailed "코드 확인 실패",
//              resolving "확인 중"
//   acting:    navigateAria (label, kind) => `${kind} ${label} 열기`
import { ko } from "../../i18n/ko";
import type { GateKind, GateStatusKind } from "../../api/ontologyActions";

export interface ObjectCardGovStrings {
  gates: Record<GateKind, string>;
  gateStatus: Record<GateStatusKind, string>;
  preflight: {
    title: (action: string) => string;
    checking: string;
    execute: string;
    executing: string;
    checklistAck: string;
    close: string;
    failed: string;
  };
  executedToast: (action: string, version: number, code: string) => string;
  override: {
    pendingTitle: string;
    approve: string;
    reject: string;
    requester: (id: string) => string;
    approvedChip: string;
    rejectedChip: string;
    failed: string;
  };
  lifecycle: {
    preflightTitle: (state: string) => string;
    blocker: string;
    warning: string;
    notConfigured: string;
    failed: string;
  };
  missingTypeId: string;
}

const FALLBACK: ObjectCardGovStrings = {
  gates: {
    authority: "Authority",
    self_checklist: "Self-checklist",
    four_eyes: "Four-eyes",
    egress_dlp: "Egress / DLP",
  },
  gateStatus: {
    not_required: "Not required",
    satisfied: "Satisfied",
    pending: "Pending",
    denied: "Denied",
  },
  preflight: {
    title: (action) => `${action} preflight`,
    checking: "Checking",
    execute: "Execute",
    executing: "Executing",
    checklistAck: "All checklist items acknowledged",
    close: "Close",
    failed: "Preflight failed",
  },
  executedToast: (action, version, code) =>
    `${action} committed · r${String(version)} · ${code}`,
  override: {
    pendingTitle: "Override pending",
    approve: "Approve",
    reject: "Reject",
    requester: (id) => `Requested by ${id}`,
    approvedChip: "Approved",
    rejectedChip: "Rejected",
    failed: "Override failed",
  },
  lifecycle: {
    preflightTitle: (state) => `Transition to ${state}`,
    blocker: "Blocker",
    warning: "Pending",
    notConfigured: "Edge not configured (denied)",
    failed: "Preflight failed",
  },
  missingTypeId: "Object-type id missing; governed actions are disabled",
};

/** ko.console.objectcardGov accessor with the English fallback. */
export function objectCardGovStrings(): ObjectCardGovStrings {
  return (
    (ko.console as unknown as { objectcardGov?: ObjectCardGovStrings })
      .objectcardGov ?? FALLBACK
  );
}

export interface ObjectCardDynStrings {
  relations: {
    codeNotFound: string;
    resolveFailed: string;
    resolving: string;
  };
  acting: {
    navigateAria: (label: string, kind: string) => string;
  };
}

const DYN_FALLBACK: ObjectCardDynStrings = {
  relations: {
    codeNotFound: "No object resolves that code",
    resolveFailed: "Code resolve failed",
    resolving: "Resolving…",
  },
  acting: {
    navigateAria: (label, kind) => `Open ${kind} ${label}`,
  },
};

/** ko.console.objectcardDyn accessor (koManifest above) with the English fallback. */
export function objectCardDynStrings(): ObjectCardDynStrings {
  return (
    (ko.console as unknown as { objectcardDyn?: ObjectCardDynStrings })
      .objectcardDyn ?? DYN_FALLBACK
  );
}
