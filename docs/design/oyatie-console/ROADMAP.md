# Acme Group 콘솔 — ROADMAP (마스터 빌드 블루프린트)

> 목적: 콘솔 **전 모듈을 엔터프라이즈 프로덕션 목업 품질**로 완성한다 — no stubs·no filler·no "good for now". 모든 화면이 상호작용하고, **온톨로지·데이터 상관·워크플로·자동화**를 실증한다. "배선(백엔드 연결)만 하면 되는" 상태가 목표.
> 이 문서는 실행 계획의 단일 출처다. 설계 원칙=DESIGN.md, 백엔드 계약=HANDOFF.md, 세션 작업목록=TODO.md, 운영노트=AGENTS.md. 매 모듈 완료 시 본 문서의 상태표를 갱신한다.

## 0. 품질 기준 (Definition of Done — 모든 모듈 공통)
1. **완결성**: 빈 화면·placeholder·"준비 중" 금지. 모든 목록·카드·액션이 실제 시드 데이터로 동작.
2. **온톨로지**: 화면의 모든 명사가 개체 — 클릭(핀 패널)/드래그(참조 토큰)/코드 링크로 상·하류 이동 가능.
3. **상관(correlation)**: 최소 2개 상류·2개 하류 개체와 실제 링크. 상태 전이 시 연결 개체에 역참조+감사 이벤트.
4. **워크플로/게이트**: 파이프라인·결재·마감은 단계 시각화 + 단일 컨텍스트 CTA. 자동화 가능 지점은 워크플로 스튜디오와 연결.
5. **PBAC**: 화면·카드·행·액션·집계가 정책 평가 결과. 민감=분류 칩+게이트, covert=deny-by-omission, 열람=감사.
6. **문법 재사용(§4.7)**: 핀/창 모델·목록(J/K·검색·열폭)·토큰(@#!)·감사 백본·no-code 편집기를 그대로 계승. 새 문법은 카탈로그에 등재 후 전체 소급.
7. **반응형·접근성**: 뷰포트 맞춤·좁은 폭 스택·모바일 드로어·가독 하한·키보드.
8. **검증**: 로드 무오류 + 배경 검증 통과. 데모 시나리오 1개 이상 재현.
9. **생애주기(§3.9)**: 해당 업무 개체는 draft→archive 단계를 명시 — 초안·상신/승인(maker-checker·SoD)·발효일(effective-dating)·개정(버전)·정산 게이트·보관(숨김·이력 보존). 파괴적 작업(폐지)은 의존 개체+법정 정산 완료 후. 하드삭제 금지.

## 1. 제품 논지 (refined)
**대기업 아웃소싱 운영 OS** — 하나의 개체 그래프 위에서 계약→인력편성→채용→근태→급여→분석→계약 수익성의 전 수명주기를 운영. **결정적(no-AI)** 거버넌스(Cedar PBAC·감사·워크플로·데이터 통합). Palantir Foundry의 온톨로지/파이프라인/계보 사고를, AI 없이 규칙·템플릿·통계로 구현. 전 직원(현장직 포함)+모바일. 다중 관할 규제 대비.

## 2. 온톨로지 (마스터 개체 그래프 — 상관의 근간)
> 개체 = (의미: 타입·속성·관계) × (동작: 이벤트·상태전이) × (역학: 정책·파생지표). 코드 발급 개체는 `!코드`로 어디서나 링크.

**조직/사람**: Group▸Entity(법인)▸Site(사업장)▸Team ; Person(직원·지원자·비정규 WorkforcePool) ; Position(사업장×직무×직책×TO) ; PolicyPreset(근무·휴게·연차·수당·여비 — 상속)
**계약/수익**: Contract`C-`(입찰·체결·이행·정산) ▸ Position ▸ Posting(공고) ▸ Applicant ▸ Employee ; Grant(국가지원) ; Bid(입찰)
**근무/급여**: Timetable ▸ Attendance(일·주52·월마감) ⇄ Substitution(대근) ⇄ OT`AP-` ▸ PayrollRun▸PayItem▸Payslip`PS-` ▸ LaborCost ▸ ContractProfitability(환류)
**거버넌스**: Approval`AP-`(기안→결재선→종결) ; AuditEvent(who/what/when/where/how/on-what/decision/integrity) ; Policy(Cedar 규칙) ; AccessGrant(일회성 TTL 토큰) ; Workflow ; Schedule
**문서/데이터**: WorkObject(`WO-`정비·`CS-`회신·`AT-`근태·`JL-`일지·`IN-`접수) ; InboxDoc(수령확인) ; IngestJob`DX-`(파일·API→온톨로지) ; Source(커넥터) ; MappingTemplate ; EvidenceRecord(원본 WORM+파생) ; EditableDocument(버전·승인)
**커뮤니케이션**: Notice·Mail·Thread·Notification(포인터) ; Task(범위+링크)
**ERP/현장/규제**: Ledger·Voucher·Purchase·Asset·Inventory ; Vendor ; DispatchOrder·MaintenanceOrder·CustomerSite ; Jurisdiction·Consent·DSR·DataClass ; Benefit(수명주기)

**표준 관계 체인**: `C- → Position → PolicyPreset → Posting → Applicant → Employee → Timetable ⇄ Attendance ⇄ Substitution/OT(AP-) → PayrollRun → Payslip → LaborCost → ContractProfitability → (환류) C-`. 어느 노드에서든 1클릭 상·하류.

## 3. 교차 시스템 (모든 모듈이 계승 — 재구현 금지)
> **북극성 벤치마크 (전반)**: **Palantir Foundry**(온톨로지·Actions·Functions·Workshop·Pipeline·계보 — 개체·구성·분석의 근간) · **Slack/Teams**(커뮤니케이션·프레젠스·스레드·협업·링크 unfurl·회의) · 모듈별 best-in-class(Workday·Greenhouse·ServiceNow·Retool/Appsmith/ToolJet 등 §4 매트릭스·HANDOFF §19). 새 표면은 이 셋 + 해당 모듈 best-in-class에 대조해 심화.
- **PBAC(Cedar)**: `permit(principal,action,resource)`; principal=직책·직급·직무·대상관계·clearance; resource=개체×카테고리; action=view/edit/export. 스코프="인가 법인 합집합". covert=deny-by-omission. `tokenVisible`·`viewerClasses` 재사용.
- **감사 백본**: `logEvent(partial)` — 상태 전이·열람 전부. seq+해시체인·deviceCtx·분류. `screen:"audit"` 피드.
- **핀/창 모델**: 헤더 드래그=팝아웃·더블클릭=핀(분할)·트레이=최소화; 상세 기본=우측 핀. `cardVal/cardToolVals/cardGrab/cardPinRight/snapTo/panels`.
- **목록 문법**: J/K/Enter·다속성 검색·열폭 드래그·공유 트랙 정렬·끝 여백/페이드.
- **토큰 문법**: `tokenParse/tokenRender/tokenType` — @멘션(알림)·#개체·!코드·바코드·날짜, PBAC 후보 게이트.
- **자동화**: `workflows/schedules` + 트리거→조건→액션; 실행 시 logEvent·실제 개체 생성. 새 모듈의 이벤트는 트리거 후보로 노출.
- **no-code 편집기**: 정책·워크플로·매핑 템플릿·프리셋 = 자연어 블록 캔버스 + 시뮬레이션 + 버전/되돌리기.
- **디자인 토큰**: `tokens/*.css` + `.console` 테마(라이트/다크). 인라인 스타일. Pretendard. 아이콘=인라인 스트로크 SVG.

## 4. 모듈 매트릭스 (벤치마크 · 상태)
> 상태: ✅완료 · 🟡부분 · ⬜신규. 각 모듈은 §0 DoD 통과 필요.

| 모듈 | screen | 벤치마크(best-in-class) | 핵심 개체 | 상태 |
|---|---|---|---|---|
| 오버뷰 | overview | Palantir/Workday home | Task·WorkObject·KPI | 🟡 심화 |
| 인사 | hr | Workday HCM | Person·인사카드(카테고리) | 🟡 |
| 채용 | recruit | Greenhouse·Lever·Ashby | Posting·Applicant·인재풀 | 🟡 |
| 조직도 | org | Workday Org·Foundry | Entity·Site·Team·Position | 🟢 생애주기(draft→archive) |
| 인사평가 | review | Lattice·15Five | Review·KPI·근태연동 | 🟡 |
| 근태 | att | Kronos·Deputy·Workday Time | Attendance·계획/실적·대근 | 🟡 심화 |
| 급여 | pay | Workday Payroll·ADP | PayrollRun·PayItem·PS- | 🟡 |
| 전자결재 | appr | 그룹웨어+ServiceNow | Approval AP-·종결 | ✅ |
| 연차 | leave | Workday Absence | Leave·촉진·거부권 | ✅ |
| 복리후생 | benefit | Workday Benefits | Benefit(수명주기)·tier | ✅ |
| 문서·기록물 | docs | Foundry Docs·M-Files·iManage | 기록물·IN-·증거(WORM) | 🟡→증거·미디어·ZIP |
| **데이터 인제스트** | ingest | **Foundry Pipeline/Data Connection**·Rossum·Airbyte | IngestJob DX-·Source·Template TP- | ✅ 매핑 템플릿 에디터·lineage |
| **오피스 편집기** | editor | **ONLYOFFICE/Euro-Office**·Collabora | EditableDocument·버전 | ⬜ P3 |
| 권한·정책 | policy | AWS Cedar·OPA·Foundry Governance | Policy·AccessGrant | 🟡→일회성 토큰·컨텍스트 · ONT resource 소비 |
| 컴플라이언스 | compliance | OneTrust·AWS Audit Manager·Purview | Jurisdiction·Consent·DSR | ⬜ P2 |
| 감사 로그 | audit | Splunk·CloudTrail·Workday audit | AuditEvent | ✅→개체별 이력·시간범위 |
| 자동화 | auto | Workato·ServiceNow Flow·Airflow | Workflow·Schedule | ✅ **typed·actionable 빌더**(파라미터화 트리거/액션·field·op·value 조건·실평가 시뮬) |
| 객체 탐색 | explore | **Foundry Object Explorer/그래프** | (전 개체 그래프) | ✅ **온톨로지 엔진**(ONT_TYPES · 노드 속성/액션/분석 패널) |
| 대시보드 | dashboard | Foundry Quiver·Tableau | 파생지표 drill | 🟡 v1(수익성·추이·커버리지·내 지표 · 전 수치 drill) |
| 인건비 분석 | laborcost | Foundry Contour·Adaptive | LaborCost·수익성 | 🟡 v1 모듈 서피스(계약별 breakdown·예측 포함) |
| 재무 | finance | SAP·NetSuite·더존 | Voucher VC-·자동전표 | 🟡 v1 모듈 서피스(wf6·급여·AP- 연동) |
| 구매 | purchase | Coupa·SAP Ariba | PO-·Vendor | 🟡 v1 모듈 서피스(WO-·재고 연동) |
| 재고 | inventory | SAP MM·Fishbowl | IV-·안전재고 | 🟡 v1 모듈 서피스 |
| 자산 | asset | ServiceNow ITAM·EAM | FL-·GPU·렌탈 | 🟡 v1 모듈 서피스(WO-·C- 연동) |
| 정비 | maintenance | UpKeep·Fiix·SAP PM | WO- | 🟡 v1(기존 WO- 개체·처리 패널 재사용) |
| 고객·현장 | field | ServiceNow FSM | CustomerSite·SLA | 🟡 v1 모듈 서피스(계약·근태·CS- 연동) |
| 컴플라이언스 | compliance | OneTrust·Purview | 의무 CP-·DSR | 🟡 v1 모듈 서피스(규제×개체 연동) |
| 게시판·공지 | board | Confluence·Slack | Notice NT- | ✅ 수령확인 진행 바 |
| 주소록 | directory | Workday·People | Person | 🟡 v1(PEOPLE 동적·메시지/메일/카드) |
| 인건비 분석 | laborcost | Foundry Contour·Adaptive | LaborCost·수익성 | ⬜ P2 |
| 예측 | forecast | Anaplan·Foundry | 시나리오(규칙기반) | ⬜ P4 |
| 재무 | finance | SAP·NetSuite·더존 | Ledger·Voucher | ⬜ P3 |
| 구매 | purchase | Coupa·SAP Ariba | Purchase·Vendor·PO | ⬜ P3 |
| 재고 | inventory | SAP MM·Fishbowl | Inventory·Lot | ⬜ P3 |
| 자산 | asset | ServiceNow ITAM·EAM | Asset·수명주기 | ⬜ P3 |
| 배차 | dispatch | Samsara·Geotab·Onfleet | WO- 큐×기사×SLA·지도 왕복 | ✅ 화면·지도 연동 |
| 정비 | maintenance | UpKeep·Fiix·SAP PM | MaintenanceOrder WO- | ⬜ P3 |
| 고객·현장 | field | ServiceNow FSM·Salesforce FS | CustomerSite·SLA | ⬜ P3 |
| 게시판·공지 | board | Confluence·Slack | Notice | ⬜ P4 |
| 주소록 | directory | Workday·People | Person·조직 | ⬜ P4 |
| 커뮤니케이션(rail↔main) | comms · mail · msgr | Slack · Gmail · **mox** | Thread·Mail·Notice | 🟢 메일·메신저 풀뷰·게시판·주소록 |
| 국가지원·조달·계약 | contract | SAM.gov·나라장터·Icertis CLM | Contract C-·Grant·Bid | ⬜ P2 |
| 개인 수신함 | inbox | Workday·payslip vault | InboxDoc·passkey | ✅ |

## 5. 시그니처 데이터-상관 데모 (온톨로지 증명 — 반드시 재현)
1. **계약 수익성 환류**: ContractProfitability(C-207) → LaborCost → PayrollRun → Attendance/Substitution → WorkforcePool. 한 화면에서 상·하류 drill.
2. **인제스트→온톨로지**: 은행 거래내역(API DX-) → Voucher(전표) → Ledger; 나라장터 공고(DX-) → Bid → Contract 후보. 계약서 스캔(DX-) → Contract C- 필드 자동 매핑.
3. **결원→대근→급여→계약**: 무단결근(AT-) → 대근(AP-·WorkforcePool) → 급여 일당 반영 → 계약 인건비.
4. **감사 상관**: AuditEvent → 「개체로 이동」+「연관 이벤트(세션·체인)」 → 객체 탐색 그래프.
5. **정책 시뮬레이션**: Policy 편집 → "누가 무엇을 보는가" 시뮬 → 실제 화면 렌더 변화(persona 전환).
6. **증거 체인**: 현장 사진/영상(EvidenceRecord WORM) → 정비오더(WO-) → 계약 이행 증빙 → 감사.

## 6. 실행 순서 (phased — 가치·의존성 우선)
- **P1 (데이터 중추)**: 데이터 인제스트 화면 → 객체 탐색(그래프) → 자동화 외부 API/no-code 캔버스. (온톨로지·상관·워크플로를 가장 강하게 실증)
- **P2 (분석·규제·계약 상류)**: 대시보드 → 인건비 분석/수익성 → 컴플라이언스(다중 관할·DSR·동의) → 국가지원·조달·계약(C- 수명주기).
- **P3 (ERP·현장운영·문서 심화)**: 재무·구매·재고·자산 → 정비(WO-)·배차·고객현장 → 문서 증거 아카이빙(미디어/ZIP) → 오피스 편집기 거버넌스 셸.
- **P4 (커뮤니케이션·마감)**: 커뮤니케이션 모듈 승격 → 게시판·주소록 → 예측 → 잔여 TODO(퇴사/휴직·조직개편 결재·비밀구역·목록 소급 audit)·DLP 억제 계층.
- **상시**: 각 신규 모듈은 §5 상관 중 관련 데모를 반드시 연결. 각 완료 후 TODO/AGENTS 갱신 + 검증.

## 7. 진행 로그
- 2026-07-04: 블루프린트 수립.
- 2026-07-04: **메일 풀뷰(커뮤니케이션 > 메일) 완료·검증** — mox 백엔드 모델(자체 프런트) · 3-pane(폴더 7·리스트·리딩) · 13메일 · 발신자 인증(SPF/DKIM/DMARC)·저장암호화 보안 패널 · 분류·PBAC·보존·litigation hold 거버넌스 · 첨부→인제스트/증거 · 연결 개체 · 컴포저(분류·DLP 외부발송 경고).
- 2026-07-04: **P1 객체 탐색(관계 그래프) 완료·검증** — 20노드 온톨로지 그래프(계약→편성→공고→지원자 · 현장→팀→직원→근태→대근→인력풀 · 근태→급여→회차→수익성 환류 · 인제스트→계약 · 감사→직원), 방사형+SVG 엣지, 노드 클릭 재중심·상/하류 패널·트레일·범례. 검증 c207→att_cho→pay_cho.
- 2026-07-04: **P1 데이터 인제스트 화면 완료·검증** — 소스(파일+API 커넥터)·큐(필터·검색·JK)·7단계 파이프라인·출처 프리뷰(스캔 OCR영역·표·JSON·미디어·ZIP·실패)·필드 매핑 검토(신뢰도·PII·검증/수정)·온톨로지 적재. 검증: 계약서→C-208, 나라장터→Bid-633 적재 + 감사 이벤트. 워크플로 외부 API 인제스트 2건 씨드. **다음: 객체 탐색(그래프) → 자동화 no-code 캔버스 (P1 잔여).**
- 2026-07-04: **조직 변경 생애주기(draft→archive) 참조 구현 완료·검증** — `orgChange` 상태기계: 초안→사전점검(영향분석·정산 blocker)→결재(maker-checker·SoD 4단계)→발효(effective-date·버전)→[폐지]정산(6개 의존·법정 항목·참조무결성 게이트)→보관(숨김·이력보존). 전이 전량 감사. 검증: ㈜코스 폐지 전 사이클 통과. DESIGN §3.9 실증.
- 2026-07-04: **생애주기 거버넌스 헌장(DESIGN §3.9.1–3 · HANDOFF §15)** — effective-dating·영향분석 사전점검·maker-checker/SoD·전결(DoA)·참조무결성 정산 게이트·변경 동결창·보관=숨김(하드삭제 금지). 벤치마크 Workday·SAP SuccessFactors·Oracle HCM·SOX·ISO 15489.
- 2026-07-08: **가드레일 참조 구현 완료(§3.10)** — 계약 기안(권한 preflight·셀프 체크 4항 attestation·four-eyes·SoD·fail-closed) + 메일 egress 게이트(개체 첨부·생애주기 상태 칩·외부×미승인/민감 차단+anomaly 감사+컴플 알림). 데모: C-209 초안 외부 발송 차단 → 가드레일 통과 상신 → C-207 게시만 허용.
- 2026-07-08: **P1 잔여 완료 — 자동화 no-code 블록 빌더 + 온톨로지 양방향 통합** — 블록(트리거6·조건6·액션6)=개체 타입 바인딩, 자동 규칙명·시뮬·저장=활성+감사; wf 「개체 체인」↔explore 「작용 자동화」 상호 1클릭(Palantir 역학 계층 실증).
- 2026-07-08: **대시보드 v1(P2 분석 시작)** — 스탯바·계약 수익성 테이블·인건비 6M 추이(현재/예상)·사업장 커버리지·내 지표(셀프 스코프) — 전 수치=개체 drill 불변식.

- 2026-07-09: **잔여 갭 소진 + 지원자 페르소나** — as-of 재구성(버전 「시점 보기」 읽기 전용·감사) · 타입 속성 스키마 no-code 편집(활성=개정 스테이징→v+1 발효) · 내 업무 할 일 행+완료 토글 · 인력풀 서피스(workforce·대근 연동) · 메일 본문 실링크 · 시리즈 자동 탐지 · **지원자 view-as v6**(「내 지원」 서피스·오퍼=수신함 passkey 수령·수신함 owner 스코프·rail 미렌더). 벤치마크 갭 레지스터 소진.
- 2026-07-21: **잔여 TODO 소진 + 벤치마크 폴리시** — #13 팀 최소 인원 게이트 TM-01(fail-closed·대근 상쇄 폐루프)+반차 부분 커버 · #18 메일 예약 발송(예약됨 폴더·발송 취소)+프레젠스 상태 설정(방해 금지=배지 억제 연동) · #14 FC-09 포트폴리오 마진×리스크 산점(제네릭 scat) · 대시보드 KPI 델타 칩(vs 6월 확정)+개체 체인 파이프라인 스트립(6 스테이지 라이브 카운트 drill) — 스크린샷 벤치마크(Workforce Ops Overview) 반영. (AGENTS 102)
- 2026-07-21: **reply-in-thread 완결 (Slack 패리티)** — 메시지별 답글 스레드(우측 패널·답글 칩·전용 컴포저·@멘션 알림·msgParts 실링크·시드 데모). (AGENTS 103)
- 2026-07-21: **콘솔 린터 신설 (Foundry Linter 패리티)** — 규칙 7종 라이브 스윕(절감·안정성·거버넌스) → 권고 행(근거·기대 효과) → Fix Proposal(비파괴·수락=스테이징/결재 게이트 라우팅·감사) + 보류·재스윕. nav 거버넌스 합류·v9 스코프. (AGENTS 106)
- 2026-07-21: **인제스트 기대치 게이트** — 결정적 expectation 4종(Severe=적재 중단 fail-closed·Moderate=경고 감사) + 검토 패널 칩 행. (AGENTS 107)
- 2026-07-21: **그래프 컬러링 렌즈** — 타입/생애주기/감사 활동 노드 재채색(라이브 파생·미니 범례·툴팁 판정). (AGENTS 108)
- 2026-07-21: **중앙 proposal 리뷰 큐** — 6계열 개정 스테이징을 내 업무 단일 큐로(four-eyes 승인/철회/원 화면 drill·민감정보+ 스코프·자기승인 차단·sc4 시드). (AGENTS 109)
- 2026-07-21: **리서치 갭 완결** — 액션 폼 빌더(params·criteria·effects+스테이징 편집)·부분 대사 매트릭스(recon)·MRP(mrp)·허들. (AGENTS 110)
- 2026-07-21: **레인 17 마감** — 메일 j/k/Enter/e (Gmail 패리티 · 필터 스코프 존중 · e2e). (AGENTS 111)
- 2026-07-21: **레인 9 마감** — 수익성 표 C-207 라이브 파생(대근 편성→인건비→마진 폐루프·결원 칩 라이브). (AGENTS 112)
- 2026-07-21: **레인 1·2·3·5 마감** — 구성 모드 위젯(분포 바·칸반 — 목록 쿼리 파생·전 세그먼트 drill) 신규 · 나머지 기구현 확인/판정. (AGENTS 113)
- 2026-07-21: **엔진 쿼리 ⓐ 1차** — 생성 위저드 개체(OB-)가 타입 매칭 모듈 행으로 자동 합류(생성→목록 폐루프·e2e). (AGENTS 114)
- 2026-07-21: **큐 소진 판정** — 레인 10 기구현 확인·레인 11 상시 전환. 잔여=대형 에픽 19–23(백엔드 계약 주도 — UI 셸 완비). (AGENTS 115)
- 2026-07-21: **생애주기 e2e directive** — 상호 재귀 프리즈 수정(재진입 가드+렌더 메모)·전 모듈 개체 전이 활성·WO- 전 파이프라인 라이브 증명. (AGENTS 117)
- 2026-07-21: **생애주기 e2e 완결** — 급여 회차 전 체인(예외→마감→계산→명부→예외→상신 AP-)·자산 FL- 라이브 증명. directive #25 완료. (AGENTS 118)
- 2026-07-21: **규제 PII 슬라이스** — DSR 셀프서비스(권리 4종→결재 개체·감사)+동의 원장(철회·법정 근거 칩). (AGENTS 121)
- 2026-07-21: **분석 병합 심화** — 감시 규칙 행(워크플로 파생·drill·시뮬)+AN- 저작 진입. (AGENTS 122)
- 2026-07-21: **AN-/FC- 저작 위저드** — 근거 선택×산식/모델×임계×라이브 미리보기 → typed 생성·행 합류(FC-901 e2e). (AGENTS 123)
- 2026-07-21: **타입 빌더·소스 빌더** — 텍스트 입력 승격 완결(directive 26 소진). (AGENTS 124)
- 2026-07-21: **즐겨찾기 nav(벤치마크 채택) + #6 근태 오늘 뷰 계층**(법인 필터·현장 접기·현장 drill). (AGENTS 125)
- 2026-07-21: **v10 CX·영업 페르소나** — deny-by-omission nav e2e. 페르소나 10종 완비. (AGENTS 126)
- 2026-07-21: **핀 버튼(인사 카드)+테마 3-way 세그+다크 토큰 audit**. (AGENTS 127)
- 2026-07-21: **법인 신설 위저드(3단계)+점진 공개 감사+BENCHMARK.md**. (AGENTS 128)
- 2026-07-21: **핀 소급(법인·팀)+DEMO.md 대본 7종** — #7·#28 마감. (AGENTS 129)
- 2026-07-21: **파이프라인 빌더(트랜스폼 체인·라이브 미리보기·개체 출력)+내 업무 태스크 편집** — Foundry 성숙도 directive 1차. (AGENTS 130)
- 2026-07-21: **PB 내부 데이터 확장** — 라이브 온톨로지 입력 4종·집계·분석 출력(AN- 합류). (AGENTS 131)
- 2026-07-21: **협업 시트 편집기** — DB→파이프라인→시트→버전→적재 폐루프. (AGENTS 132)
- 2026-07-21: **내 업무 성숙 마감** — 캘린더 클릭=편집·칸반/반복 판정. (AGENTS 133)
- 2026-07-21: **+ 만들기 유형 선택(8 빌더 단일 진입)·+ 할 일 모달·칸반 레인 +**. (AGENTS 134)
- 2026-07-21: **+ 만들기 전역 통합** — Quick Actions 중복 제거·10타일 단일 진입. (AGENTS 135)
- 2026-07-21: **시트 진입 전 모듈 일반화**. (AGENTS 136)
- 2026-07-21: **PB 브랜치**(비파괴 저장·재개). (AGENTS 137)
- 2026-07-21: **PB 표현식 6종·+ 할 일 일원화(사용자 편집)**. (AGENTS 138)
- 2026-07-21: **급여 명부→시트(민감 감사)** · 오피스 편집기 셸 완결 판정. (AGENTS 139)
- 2026-07-21: **조직도 편집 완성** — 삭제 가드·diff→개편 결재. (AGENTS 140)
- 2026-07-21: **비밀 구역(CEO 전용)** — deny-by-omission nav·등급 가드·보상 원장·민감 스트림. (AGENTS 141)
- 2026-07-21: **법인 카드 재무 요약(PBAC 게이트·열람 감사·drill)** — #9 마감. (AGENTS 142)
- 2026-07-21: **인사 카드 조직 표기 drill(팀·법인)** — #10 마감. (AGENTS 143)
- 2026-07-21: **급여 명부 열 폭 드래그** — #8 목록 문법. (AGENTS 144)
- 2026-07-21: **증거 인콘솔 뷰어/플레이어**(워터마크·재생·custody·egress 게이트) — epic 19 슬라이스. (AGENTS 145)
- 2026-07-21: **CP-016 개인정보 처리현황 대장**(PIPA §30) — 규제 PII 슬라이스. (AGENTS 146)
- 2026-07-21: **뷰포트 매트릭스 검증+밀도 스케일**(densityZoom·33모듈 오버플로 스윕·2건 수정). (AGENTS 147)
- 2026-07-22: **계약→포지션→프리셋 체인 편집기**(상속·오버라이드 시각화·개정 스테이징) — #15. (AGENTS 148)
- 2026-07-22: **평가 스코어카드+인사 카드 평가 이력**(컨텍스트 자동 첨부·RV- 개체·PBAC) — #18. (AGENTS 149)
- 2026-07-22: **연장근로 체인 완결**(승인→wf3 자동화→급여 반영) — #17. (AGENTS 150)
- 2026-07-22: **개체화 마감+토큰 정규식 26종 확장** — #16. (AGENTS 151)
- 2026-07-22: **출입 컴팩트 인원카드+image-slot 사진** — #20. (AGENTS 152)
- 2026-07-22: **정책 토큰 TK- 원장**(발급·회수·만료 — 한시 권한 개체) — PII 백로그. (AGENTS 153)
- 2026-07-22: **컨텍스트-구동 접근통제**(ctxGate·민감 3면 소급) — PII 백로그. (AGENTS 154)
- 2026-07-22: **CP-017 안전조치 체크리스트** — PII 백로그. (AGENTS 155)
- 2026-07-22: **전 모듈 진실성 audit** — 허위 수치 5건 수정·정합 검증. (AGENTS 156)
- 2026-07-23: **필드 분류 라벨링**(일반/개인정보/민감 순환 · 2면) — PII 백로그. (AGENTS 157)
- 2026-07-23: **관할=개체**(법인 카드 관할 체인→규제 drill) — PII 백로그 프런트 마감. (AGENTS 158)
- 2026-07-23: **DLP 억제 계층(비밀 구역)+audit 2차**(컴플라이언스 배지 파생화). (AGENTS 159)
- 2026-07-23: **3차 심층 audit+재구성성 스윕**(생성 경로 인벤토리 — 채용공고 「공고 등록」 갭 해소). (AGENTS 160)
- 2026-07-23: **4차 종합 audit** — 검색·대시보드·린터·예약·지원·규제 개정 동선 전수 e2e · 갭 0. (AGENTS 161)
- 2026-07-23: **개체 구독(watch·전이 알림)+코스 사업영역 정정**(생산·물류도급·통합시설관리·물류장비). (AGENTS 162)
- 2026-07-23: **결재함 일괄 승인**(가드형 mass-change) — SAP 패리티. (AGENTS 163)
- 2026-07-23: **ad-hoc 차트 빌더**(Quiver 패리티 — 라이브 집계·AN- 저장) — 갭 레지스터 소진. (AGENTS 164)
- 2026-07-23: **적대적 워크플로 audit** — 근태→급여 골든 패스 완주·게이트 정당성 판정·stat 파생화 픽스. (AGENTS 165)
- 2026-07-23: **fix-link e2e·생성 경로 재검증** — #33 마감. (AGENTS 166)
- 2026-07-23: **통합 개요 from-scratch 재구성 검증**(비우기/복원 데모·재구성 e2e·크래시 픽스·배차 스탯 파생화). (AGENTS 167)
- 2026-07-23: **사람·조직 상세 커버리지**(직원 위저드 고용형태·연락처·기본급 + 법인 위저드 대표자·사업자·소재지 → 카드 반영). (AGENTS 168)
- 2026-07-23: **N+1 enum 확장+타입어헤드 규모 패턴**(직급·고용형태·업종 직접 입력 / 토큰 대상 인물 검색). (AGENTS 169)
- 2026-07-23: **입력 자동 정규화**(휴대폰·금액·사업자번호 마스크 — 이탈 불가). (AGENTS 170)
- 2026-07-23: **typed 위저드 타입 완결**(정비·현장·편성·인력풀 레지스트리 보강 — WO- 콘솔 생성 가능). (AGENTS 171)
- 2026-07-23: **법인 카드 인라인 편집**(셋업 중=직행·확정=기안 경유 — §4-27 마스크). (AGENTS 172)
- 2026-07-23: **인사 카드 연락처 인라인 편집**(직행 §3.9.0-①·마스크). (AGENTS 173)
- 2026-07-23: **인사 카드=직원 원장**(전 모듈 이력 병합·개체 링크·drill). (AGENTS 174)
- 2026-07-23: **컴포저 대상 타입어헤드**(그래프+인원 검색 — §4-27-④ 소급) — #36 마감. (AGENTS 175)
- 2026-07-23: **typed link 관계 칩**(첨부=관계 자동 추론+순환·감사) — Foundry link type. (AGENTS 176)
- 2026-07-23: **부재=자동 인수인계**(결원 자동 트리거·TK 경계 패키지·연차 OOO 위임+휴가 보호). (AGENTS 177)
- 2026-07-23: **§4-28 자동화=결정적 또는 수동(무AI)** 헌장 등재. (AGENTS 178)
- 2026-07-23: **wf8 P0 근무외 프로토콜**(당직 온콜·에스컬·break-glass 사후결재 — 결정적). (AGENTS 179)
- 2026-07-23: **DoA-E1 granular 설정 개체**(파라미터 편집→규칙 라벨 파생·four-eyes v+1). (AGENTS 180)
- 2026-07-23: **조건 field 52종**(판정 12+온톨로지 속성 파생 — N+1 폐루프). (AGENTS 181)

## 8. 페르소나 워크플로 매트릭스 (2026-07-08 directive · 역할별 e2e 기준)
> 각 역할의 실제 하루 동선이 설계 기준. 신규 화면은 해당 역할 동선에서 3클릭 내 핵심 업무 도달을 검증한다.
- **HR 담당(김성아)**: 채용 파이프라인→입사확정→근로계약(수신함 passkey)→온보딩 체크→인사카드 · 예외: 무단결근 소명·촉진 발송. **✓ audit 2026-07-09** — v2 nav 26종·recruit 카드 양방향·leave 촉진 도달 3클릭 내.
- **배차 담당**: WO- 큐(SLA 칩)→가용 기사 매칭→배정 승인→추적→정산 연동. **✓ audit** — dispatch 화면(v1·v3)·처리 패널·지도 왕복; 전담 페르소나는 미분리(v1 수행).
- **지게차 기사/현장직(모바일)**: 출근 체크→WO- 수신→작업일지(JL-)→연장근로 AP-→본인 급여·수신함. **✓ audit 2026-07-09 — v7 김성호 신설**: 내 업무=배정 WO- 행(dpRows 공유 §4-18)·일지 등재 직행·본인 명세 PS-2618(owner 스코프)·모바일 탭 viewer 게이트. 잔여: 출근 체크인 UI(백엔드성).
- **공장 반장**: 교대 편성→결원 감지(근태 타임라인)→대근 편성(인력풀)→승인→일지. **✓ audit** — v3: att 결원 행→subOpen→AP- 3클릭, mywork 배차 특수 분기.
- **급여 담당**: 근태 마감 게이트→회차 생성(예약작업)→예외 검토(공제·대근비)→이체 승인→명세 배포(수신함). **audit** — 플로는 pay+auto+inbox로 완결(v1·v2 수행) · 전담 페르소나 미분리.
- **사무직(전사원)**: 개인 inbox·기안·메일·메신저·본인 근태/급여/연차 셀프서비스. **✓ audit** — v4: nav 15종·급여 명부/감사/정책 비노출.
- **지원자(외부 · 2026-07-09)**: 「내 지원」 단계 확인→오퍼 수신함 passkey 수령확인→(입사 확정 시 직원 전환) — 내부 화면·rail·타인 데이터 전부 deny-by-omission.
- **임원/경영진**: 대시보드→계약 수익성 drill→인건비→전결 결재·감사 스트림. **✓ audit** — v5 전 화면·전 수치 drill.
- **CX/영업**: 외부 메일(견적 CS-)→계약 기안(가드레일)→공고/편성 체인.
- **컴플라이언스/감사**: 감사 피드→이상 칩→상관 drill→정책 시뮬→override 게이트.
- 2026-07-08: **모듈 서피스 롤아웃 — ERP·현장운영·컴플라이언스·인건비·게시판·주소록 10화면 일괄 가동**. 공통 문법(목록 공유트랙+상세+상태칩+개체체인 drill) 단일 템플릿(`MOD_SCREENS`) — 전 행·링크·액션이 기존 개체(AP-·WO-·C-·CS-·DX-·payrun·site)로 연결, 액션=실제 플로(기안 프리필·기록물 등재·처리 패널·메일). 내비·팔레트·rail 더보기 전부 실화면 배선 — nav 스텁 0.

- 2026-07-08: **메신저 풀뷰(rail↔main 승격)·Cedar 캔버스·채용 양방향·파일=경계 포맷 헌장(§4-13) 완료** — 커뮤니케이션·거버넌스 P4 잔여 항목 해소. 메시지 속 개체 코드·멘션 = 실링크 검증.

- 2026-07-08: **메신저 풀뷰 Slack/Teams 패리티 완결** — 섹션 사이드바·프레젠스·검색·그룹핑·미독 디바이더·ack/답장 인용/할일·회의 MT- 개체·@멘션 알림 계약·개체 코드 칩·컴포저 자동완성·**스크롤 랜딩**(진입=디바이더/맨 아래, 전송=맨 아래). 알림 풀뷰 크래시(tokenRender.map) 수정. 검증기 전 항목 실동작 확인.

- 2026-07-08: **#18 생애주기 소급 완료 (계약·기록물·인제스트 · §3.9)** — 제네릭 생애주기 엔진+단일 모달(조직 변경 문법 일반화): 초안→검토·결재(SoD)→활성·게시→보관(참조무결성 게이트)→폐기(보존기한·legal hold 게이트) · 버전 이력·롤백(비파괴)·개정=sandbox(이전 버전 활성 유지)·발효일 · egressDocs 양방향 동기(메일 egress 게이트 연동) · 진입 = 문서·기록물 행·인제스트 적재 개체·explore 「생애주기」 칩. 데모: C-207 v3 개정→발효 v4 · IN-0301 보존기한 만료 처분(PIPA 파기).

- 2026-07-08: **모듈 = 개체 서피스 · 시리즈 · 규제 원장 (§4-14·15·16)** — 파일-1급 스윕 완료(증빙 구조화·메일 첨부 인제스트 primary·기안 증빙 fail-closed) · 온톨로지 그래프 머지(모듈 행 전부 typed 노드·자동 엣지·수동 관계 그리기) · 개체 카드 3계층(속성+생애주기+역학 칩) · 지속 개체 SR- 6종(인스턴스 타임라인·추세·예정) · 규제 개체 RG-(최저임금 영향→조정 기안) · 대시보드 인사이트 AN- 5건(근거 체인+처방 액션).

- 2026-07-08: **역할 e2e·모바일 분리·갭 클로징 일괄** — view-as 5종(전환=감사·nav/팔레트/내 업무 deny-by-omission·데이터 스코프 게이트) · 모바일=별도 산출물(Oyatie Mobile.dc.html — iOS 프레임+iframe, 7종 모듈·하단 탭 바·모바일 시트) · 거래처 CL- 4종(OT-12 활성)·재고 매트릭스·자산 타임라인·게시판 진행 바(제네릭 stock/tl/prog) · 설명 캡션 스윕 완료 판정(잔여 2건 제거) · 엔터프라이즈 표준 FW-01~04(HANDOFF §17) · 지도 저작(편집·드래그·우클릭)·자동화 개정 스테이징(§3.9.0) · 벤치마크 갭 레지스터 신설(TODO).

- 2026-07-09: **자율 백로그 드라이브 완료** — n8n 실행 타임라인·정비 SLA 칸반·모바일 2-pane 스택·대시보드 스코프×기간·Slack 무음·Gmail 스레딩·Vanta 통제→증거 매트릭스·급여=SR-205 연결·**증거 아카이빙 EV-(WORM·해시·custody·적격 칩)**·**오피스 편집기 거버넌스 셸(C-209 — 버전·PBAC·DLP)**. 벤치마크 갭 레지스터 실질 소진(잔여: as-of·타입 속성 편집·완료 토글 = 후순위). P0–P4 코어 백로그 소진 — 이후 신규 directive·폴리시 스윕 체제.

- 2026-07-09: **폴리시 스윕 — §4-19 필드 타입 enum 소급 + 모바일 마감** — 모듈 행 제네릭 `en`(typed enum) 필드: 재무 계정·방향, 구매 구분·품목군, 재고 위치·품목군, 자산 보유·분류, 정비/배차 유형·원인, 현장 서비스, 컴플라이언스 구분(의무/규제/표준), 게시판 유형, 경영분석 단위, 인력풀 유형·보안등급 — 상세 칩 클릭=동일 값 목록 필터(검색·J/K 포함). 모바일: 탭 바 viewer 게이트(v6 지원자=내 지원·공고·수신함·메시지 4탭·더보기 필터) · 스와이프 액션(메신저 목록=무음 토글·메일 목록=보관, DOM transform 문법) · 컴포저 키보드 세이프(visualViewport inset — 탭 바 숨김+본문 패딩). 지원자↔채용담당 채널·모바일 지원자 뷰 잔여 소진.

- 2026-07-09: **페르소나 워크플로 audit + 모바일 베스트 프랙티스** — §8 매트릭스 전 행 판정(✓) · 갭 해소: v7 정비 기사 김성호(내 업무=배정 WO- 행 dpRows 공유·일지 등재·본인 명세 owner 스코프) · mywork 수신함 owner 스코프 일반화. 모바일: 엣지 스와이프 백·시트 드래그 닫기·iOS 줌 방지(16px 인풋)·tap-highlight/더블탭 줌 제거·active 피드백.

- 2026-07-09: **인력풀 ↔ 채용·인사·Cedar 체인 (directive)** — 인력풀 유입=채용 경유(인력풀 공고 r6 · pool 확정=인력풀 등재 — 재직 직원 미생성·wpJoined·감사·공고 provenance kv) · `wpAll()` 단일 조회(화면·대근 모달·배정) · 명부 고용 상태 empSt enum + `hrMatch` 단일 필터(휴직·기간제·입사 예정=비활성 — 근무/현장/이상 집계·근태 로스터 편성 제외, dim 행·전용 필터·인력풀 비합산 칩) · Cedar p9(인력풀 인사정보 열람 스코프)·p10(비상근 사내 모듈 금지)·p11(비활성 편성 제외) 시행 + 고용 상태 principal 블록 · 데드엔드 스탯 5건 실배선.

- 2026-07-09: **어고노믹·통합 슬라이스 (Palantir/Teams/Slack 벤치마크)** — 모듈 테이블 열 정렬(숫자·₩·% 인식·토글·인디케이터 — 전 모듈 공통) · 메신저 개체 카드 unfurl(Teams 문법 — 코드→미니 카드·클릭=개체 이동) · 대근 배정=건별 근로계약 자동 발행(수신함 passkey 수령=계약 확인) · 출근 체크인/아웃(현장 페르소나 내 업무) · 인재풀→인력풀 전환 제안(Greenhouse→WFM 체인). 잔여 백로그 = TODO 「잔여 백로그 레지스터(durable)」 단일 출처화.

- 2026-07-09: **채용공고 스코프 정리 (directive)** — 채용공고·내부 공모 = 인사 그룹 postings 화면 유지. 공개 범위 = typed enum(rcData scope: internal/external) — **외부 인원(v6)은 내부 공모 존재 자체 비노출**(cdOpen 필터 deny-by-omission · Cedar p12 시행 · 「외부 · 지원자」 principal 블록 · 행 「공개 범위」 enum 칩).

- 2026-07-09: **공고 등록 컴포저 (directive)** — typed-필드 모달(포지션·법인·현장·고용 형태·공개 범위·충원 스테퍼·마감·자격 요건 칩) · fail-closed 필수 검증 · 「초안 저장」(모집 비노출)/「게시」(§3.9.0-④ 권한 행위·감사) 분리 · 초안 행 「초안 · 게시」 칩·내부 공모 purple 칩 · recruit 안내 캡션 삭제.

- 2026-07-09: **메신저 3계층·근무 형태 결재·nav 하단 관례** — rail 3섹션(#채널/▸회의 LIVE·종료 보존/DM)·새 대화 팝오버·회의 종료 헤더 · 외근·출장·재택 신청=lvReqs 결재 큐(enum 톤·AP- ref·근무 형태 감사) · nav 하단 고정 섹션: 지원 센터·설정(방해 금지 토글 실동작·passkey 관리)·정보(해시체인 앵커·단축키) · 개요 오늘 패널 스니그핏.

- 2026-07-09: **트레이=Dock·창 컨트롤·지원 센터** — 트레이 칩 hover peek 미리보기·위로 드래그=꺼내기·리프트·디클러터 · 자유 오버레이=컨트롤 상시(최상위 플로트) · 지원 센터 모듈(SUP- 티켓 4유형 enum·SLA·FAQ 4종 셀프 해결→기능 직행·티켓 접수 모달·전 페르소나·모바일·그래프 합류).

- 2026-07-09: **설정 가능화 — 인수인계 완결 (directive)** — `HANDOVER_POLICY()` 편집 가능 설정 개체(state 오버레이·버전) + 정책 편집 UI(HO-01 카드·autoAct 세그먼트·fitFloor 스테퍼·개정 스테이징 §3.9.0·four-eyes 발효·현재 케이스 자동 재판정) + 부서장 매핑=조직도 조회(`deptHeadOf` — 하드코딩 이름 제거) + 부서장 조율 큐(내 업무 스탯·행·배정/연기 결정·감사) + APPR_ROUTING 결재선 설정 개체. 검증 e2e: fitFloor 80→85 발효 v1→v2 · WO-2644 재에스컬레이션 · 조율 큐 결정.

- 2026-07-09: **워크플로 스튜디오 = typed·actionable config (directive · n8n/Workato/Foundry)** — 트리거/액션 **파라미터화**(cfg·enum/text) + 조건 = **field·operator·value 술어**(WF_COND_FIELDS 8종·타입·연산·단위) + 시뮬 **실평가**(트리거 cfg 필터·조건 평가·표본×통과 실계산·감사) + 저장 cfg 영속·개정 rehydrate. 인수인계 → wf7 「결원→인수인계」 규칙 이전 + HO-01 단독 정책 에디터. 검증 e2e: 근태·무단결근·전사 + 결근≥3회 → 표본 1·통과 1 → AP- 생성. 자동화 모듈 매트릭스 = **typed·actionable 빌더**.

- 2026-07-09: **온톨로지 엔진 (single engine, multiple consumers — directive · Foundry/Maven)** — `ONT_TYPES()` 단일 타입 레지스트리(16 타입 = typed 속성 스키마 + 관계(링크) 유형 + 액션(writeback) + 분석(파생), `state.ontTypeDefs` no-code 오버레이). **소비자**: 객체 탐색 그래프 노드 카드(**액션**·invokable `ogActionRun` 감사 / **속성**·타입 배지 / **분석**·산식 패널 — 단순 노드 이동 초월) · 정책 resource(ONT 타입 자동 노출 — single source). 검증 e2e: C-207 계약 카드 액션 3·속성 7(typed)·분석 2, 「수익성 분석」→분석 노드 재중심. **잔여**: 관계 유형 편집기·분석 편집기·모듈 서피스 엔진 소비(하드코딩 제거)·객체/타입 CRUD 단일 엔진화·정책/컴플라이언스 typed 실평가.

- 2026-07-10: **실행 큐 레인 1·2·3·5·9·17·10 + 16 시드 완료 (AGENTS 91–100)** — ① 창 모델 소급: leave 3섹션 카드 존(패턴 세터 — 핀·플로트·트레이·split·프리셋) → benefit·docs 단일 카드 존 재사용(appr=탭 워크스페이스 의도적 제외) ② 대시보드: 구성 위젯 {count|trend|dist} 온톨로지 쿼리 바인딩 제네릭화 + 7월 스탯 6종 라이브 실계산(DASH_CONTRACTS 단일 소스·6월=마감 스냅샷·추이=SR-205 소비) ③ 기안: 증빙 fail-closed 지출류 전체 + §68 금액 투영 패널 ④ 키보드: 급여·공고·월간 J/K/Enter(초크포인트 공용)·aria 무명 버튼 0 ⑤ WORM 뷰어: EV- 원본 봉인 페인(fail-closed)·파생 프리뷰(열람 감사)·ZIP readonly 엔트리 트리 ⑥ 미편성 결원 SLO 알림 시드(대근 편성 시 자동 해소).
- 2026-07-10: **실행 큐 잔여 소진 (AGENTS 101) — 레인 7·#11·체크인·§18.2·커버 플래너** — 인제스트 매핑 템플릿 TP-01~07 = 재사용 개체(no-code 에디터·변환 enum·사용 작업 drill·활성=개정 스테이징 four-eyes·초안→게시·보관=참조 무결성) + **계보 스트립**(소스→변환·템플릿→검증→개체 — 전 노드 drill) · **퇴사·휴직 생애주기**(사유 enum·발효일·사전점검·SoD 4단계·empSt 전환·회수 정산 6항 fail-closed·복직 전환) · **출근 체크인 심화**(기기×지오펜스 게이트·실적 타임라인 실시간·교대 스왑=결재 큐) · **§18.2**(정의 개정 발효일 구현 창·속성/관계 일몰 deprecated 30일→보관) · **커버 플래너 D+7**(승인 부재×커버 필수×편성 포워드 큐·미래 일자 대근 편성·주간 점검 예약 시드). **다음 = AGENTS 「다음」**: §4-22/23 audit → [~]13 엣지·14·15·17·18 → 대형 에픽 19–23.
