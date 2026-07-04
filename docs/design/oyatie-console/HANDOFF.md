# HANDOFF.md — 백엔드 구현자 인수인계

> 프런트(Oyatie Console)는 **온톨로지·이벤트·정책(Cedar PBAC)**을 UI로 시뮬레이션한다. 이 문서는 그 UI 계약을 실제 백엔드로 구현할 때의 데이터 모델·이벤트·정책·통합 지점을 정리한다. Palantir Foundry(온톨로지/액션/펑션) 벤치마크.

## 0. 아키텍처 원칙
- **온톨로지 우선**: 모든 명사·동사가 typed object. 화면은 object의 뷰. 관계는 traversable edge.
- **3계층**: 의미(타입·속성·관계) / 동작(이벤트·상태전이) / 역학(Cedar 정책·워크플로·파생지표). 한 object에 겹쳐 노출.
- **모든 것이 정책 평가 결과**: 화면·카드·행·액션·검색·집계·배지까지 `permit(principal, action, resource)` 통과분만 렌더. deny-by-omission.
- **모든 상태 전이 = append-only 이벤트**: `(actor, ts, action, [linked objects], reason?, before/after, policyDecision, ip/session)`. 감사 로그 = 이 이벤트 스트림.

## 1. 코어 오브젝트 (테이블/타입)
- **Org**: Group→Entity(법인)→Site(사업장)→Team. `entity.visible` 정책(비공개 법인 deny-by-omission).
- **Person**: 직원/지원자. 속성=직책·직급·직무·소속·입사일·본인여부(me). principal 속성 원천.
- **Contract `C-`** → **Position**(site×job×title×TO) → **PolicyPreset**(근무·휴게·연차·수당·여비; 상속: 법인←사업장←직무←포지션).
- **WorkObject(행=개체)**: `AP-`(결재) `WO-`(정비) `AT-`(근태예외) `CS-`(회신) `JL-`(업무일지) `IN-`(접수). 공통: code, status, 결재선/담당, linkedObjects[], events[].
- **PayrollRun**(회차)·PayItem·PayslipDoc `PS-`. **Attendance**(일별·주52h·월마감 게이트). **Leave**(부여/사용/촉진). **Benefit**(제도=수명주기 object). **Posting**(공고)·**Applicant**(단계). **CommObject**: 공지·Mail·Thread·Notification(포인터).
- **InboxDoc(개인 수신함)** ← 이번 구현. 아래 §3.

## 2. Cedar PBAC (역학 계층)
- principal = Person 속성(직책·직급·직무·대상관계 본인/직속/담당) + clearance(covert).
- resource = object + **카테고리(카드 섹션) 단위 attribute**. action = view / edit / export.
- 규칙은 no-code 자연어 블록으로 저작 → Cedar로 컴파일. 시뮬레이션("누가 무엇을 보나")·버전·롤백 필수.
- **스코프 상대성**: "그룹 전체" = principal 인가 법인들의 합집합. 모든 집계(KPI·합계·배지·검색·drill)는 인가 범위 내에서만 계산.
- **열람도 기록**: view 성공도 감사 이벤트. 단 본인 급여 등 self-view는 권리 → 감사 제외(정책 플래그).
- **Covert**: CEO 지정 비밀인가만. 미인가 principal에겐 섹션·메뉴·검색·칩 미렌더. 인가자 명단·role 자체도 covert. 인가자 열람은 CEO 전용 감사 스트림.

## 3. 개인 수신함 · passkey (이번 구현 — 우선 백엔드화)
- **InboxDoc**: `{id, kind(pay|contract|rule|promote|refusal), ref, title, from, date, legal:bool, basis?, body[], links[], confirmed:{by,at}|null, ownerPersonId}`.
- **수령확인 = 법적 증빙**: `legal && !confirmed` 문서는 **passkey(WebAuthn/FIDO2) 본인인증 후에만** body 공개. 인증 성공 = 수령·열람 증빙 → `confirmed{actor, ts}` 기록 + 감사 이벤트(불변). 급여명세 등 일상 문서는 무마찰(passkey 없음, self-view 감사 제외).
  - 구현: `navigator.credentials.get()` (플랫폼 인증기). 서버는 challenge 발급·서명 검증·수령 타임스탬프 공증(가능하면 RFC3161/서명). 프런트는 현재 인증 UX만 모사(`pkAuth` 1.05s 스캔 시뮬).
- **발신측**: 회사→개인 법적 통지(근로계약·취업규칙 변경·연차촉진·노무수령거부권)는 전자결재 `AP-`로 상신 → 승인 → 대상자 InboxDoc 생성 → 수령확인 대기. AP-의 마지막 단계 `수령확인`이 InboxDoc.confirmed로 종결(양방향 링크: `AP.receiptDoc ↔ InboxDoc`).

## 4. 연차 촉진 · 노무수령거부권 (근로기준법 §61)
- `LeavePromotion{personId, round(1|2), leaveRemaining, ap:AP-, receiptDoc:InboxDoc, deadline}`. 1차→2차 라운드 추적. 미사용 연차 잔여 계산은 Attendance/Leave에서 파생.
- `LaborRefusal{personId, ap:AP-, receiptDoc}`. 둘 다 결재라인 전원 알림 + 감사. 서면 대체 필요 시 동일 object에서 출력·회수 확인으로 연결.

## 5. 종결(finalization) 워크플로
- 최종승인 ≠ 종결. 작성자(없으면 담당자)가 결과 확인 후 직접 종결 → 문서함 이동(24h grey-out). 상위 관리자는 Cedar로 종결 override(별도 사유·감사). Cedar 인가자(감사·컴플·CEO)는 최종승인·종결 후에도 반려/거부(전원 알림+감사).

## 6. 자동화 · 예약작업 (스텁 → 구현 대상)
- **워크플로 스튜디오**: object 타입·관계를 트리거/조건/액션 블록으로. 이벤트 발생 시 자동 실행(예: 무단결근 3회→인사 알림+소명 기안 자동생성; 연차 소진율<20% & 7/1→촉진 1차 자동발송). 벤치마크 Workato/ServiceNow Flow.
- **예약작업(cron)**: 근태 마감 리마인더·월 급여 회차 생성·보존기한 만료·연차 촉진 배치·정기 리포트. 자연어 스케줄("매월 25일")+다음 실행 미리보기+실행 로그·재시도. 벤치마크 Airflow/Temporal.
- 자동화가 생성하는 모든 object/이벤트도 §2 정책·§0 감사 이벤트를 동일 적용.

## 7. 감사 로그 (스텁 → 구현 대상)
- 모든 이벤트 object를 tamper-evident 시계열로. actor·ts·action·target·before/after·reason·ip/session·policyDecision. object/사람/정책별 필터·전문검색·시간범위·상관관계(세션/체인) drill·이상탐지(민감열람 급증·권한상승·비정상시간)·보존/불변(append-only)·서명·내보내기. 열람 자체도 감사. CEO 전용 covert 스트림 분리. 벤치마크 Splunk/CloudTrail/Workday audit.

## 8. 통합 지점 체크리스트 (새 기능마다)
(a) 관련 object에 참조 토큰·링크 칩 연결  (b) 상태 전이 시 연결 object에 역참조·이벤트  (c) 상·하류 한 번 클릭 이동. "이 기능이 어떤 object와 연결되나" 답 못하면 미완성.
