import type { ObjectCandidate, ObjectRef } from "../console/composer/objectKinds";

/**
 * Static fixtures for the token-composer fidelity demo (`ComposerDemo.tsx`).
 * Korean display names live here under `src/test/` so `check-ui-strings` treats
 * them as fixtures, not shippable UI copy (the demo renders no real user text).
 */
export const COMPOSER_DEMO_CANDIDATES: ObjectCandidate[] = [
  { kind: "person", code: "u-hong", label: "홍길동", search: "홍길동" },
  { kind: "workOrder", code: "WO-20260612-001", id: "wo-1", label: "케이앤엘 · GTS25DE", search: "" },
  { kind: "approval", code: "AP-3121", id: "ap-1", label: "특수검진비 청구", search: "" },
];

export const COMPOSER_DEMO_RESOLVED: Record<string, ObjectRef> = {
  "person:u-hong": { id: "u-hong", name: "홍길동" },
  "workOrder:WO-20260612-001": { id: "wo-1", code: "WO-20260612-001", name: "케이앤엘 · GTS25DE" },
  "approval:AP-3121": { id: "ap-1", code: "AP-3121", name: "특수검진비 청구" },
};

/** A stored message exercising mention + object-link + code-link chips, plus an
 * unauthorized `!AP-9999` that must stay inert plain text (deny-by-omission). */
export const COMPOSER_DEMO_TEXT =
  "@u-hong 정비 #WO-20260612-001 관련 !AP-3121 확인 부탁드립니다 (미권한 !AP-9999 은 링크 안 됨)";
