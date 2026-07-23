# Acme Group 콘솔 — ROADMAP (마스터 빌드 블루프린트)

> 목적: 콘솔 **전 모듈을 엔터프라이즈 프로덕션 목업 품질**로 완성한다 — no stubs·no filler·no "good for now". 모든 화면이 상호작용하고, **온톨로지·데이터 상관·워크플로·자동화**를 실증한다. "배선(백엔드 연결)만 하면 되는" 상태가 목표.
> 이 문서는 실행 계획의 단일 출처다. 설계 원칙=DESIGN.md, 백엔드 계약=HANDOFF.md, 세션 작업목록=TODO.md, 운영노트=AGENTS.md. 매 모듈 완료 시 본 문서의 상태표를 갱신한다.
> **권한 연대기(문서 범위 상태 구분):** 이 문서의 Cedar/PBAC 항목과 완료 로그는 목업·작성·시뮬레이션·목표 계약을 기록한다. 별도 공존 맵 승격 증거가 없는 한 이 문서가 전제하는 상태는 레거시 서버 권한/미들웨어와 PostgreSQL RLS 집행, Cedar target/shadow다. 이 상태 구분은 배포·런타임 검증 증거가 아니며, 실제 집행 상태는 별도 운영 증거로 검증해야 한다.
>
> **ADR-0025 프로덕션 상태 오버레이 (2026-07-20):** 아래의 `완료`·`검증` 기록은 개발 인벤토리와 해당 시점의 제한된 검증을 뜻하며 프로덕션 준비도 승격이 아니다. 화면 상태는 (1) 정보구조에만 있는 `DECLARED/UNMOUNTED/DARK`, (2) 소스에 본문이 연결됐지만 증거 승인을 받지 않은 `MOUNTED/DARK`, (3) ADR-0025 전체 증거 요건을 승인받아 매니페스트에 포함된 `EXPOSED`로 구분한다. 현재 `EXPOSED_SCREEN_KEYS`는 비어 있다. `/console/*`는 서버 소유 롤아웃 응답과 증거 승인 매니페스트가 모두 허용할 때만 열리며, 그 외에는 작동하는 레거시 `/overview`로 fail closed한다.

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
**문서/데이터 목표 모델**: WorkObject(`WO-`정비·`CS-`회신·`AT-`근태·`JL-`일지·`IN-`접수) ; InboxDoc(수령확인) ; IngestJob`DX-`(파일·API→온톨로지) ; Source(커넥터) ; MappingTemplate ; EvidenceRecord(원본 보존/불변 목표+파생; object-lock·신뢰 앵커 미입증) ; EditableDocument(버전·승인)
**커뮤니케이션**: Notice·Mail·Thread·Notification(포인터) ; Task(범위+링크)
**ERP/현장/규제**: Ledger·Voucher·Purchase·Asset·Inventory ; Vendor ; DispatchOrder·MaintenanceOrder·CustomerSite ; Jurisdiction·Consent·DSR·DataClass ; Benefit(수명주기)

**표준 관계 체인**: `C- → Position → PolicyPreset → Posting → Applicant → Employee → Timetable ⇄ Attendance ⇄ Substitution/OT(AP-) → PayrollRun → Payslip → LaborCost → ContractProfitability → (환류) C-`. 어느 노드에서든 1클릭 상·하류.

## 3. 교차 시스템 (모든 모듈이 계승 — 재구현 금지)

> **북극성 벤치마크 (전반)**: **Palantir Foundry**(온톨로지·Actions·Functions·Workshop·Pipeline·계보 — 개체·구성·분석의 근간) · **Slack/Teams**(커뮤니케이션·프레젠스·스레드·협업·링크 unfurl·회의) · 모듈별 source-cited(Workday·Greenhouse·ServiceNow·Retool/Appsmith/ToolJet 등 §4 매트릭스·HANDOFF §19). 새 표면은 이 셋 + 해당 모듈 source-cited에 대조해 심화.
- **PBAC(Cedar)**: `permit(principal,action,resource)`; principal=직책·직급·직무·대상관계·clearance; resource=개체×카테고리; action=view/edit/export. 스코프="인가 법인 합집합". covert=deny-by-omission. `tokenVisible`·`viewerClasses` 재사용.
- **감사 백본**: `logEvent(partial)` — 상태 전이·열람 전부. seq+해시체인·deviceCtx·분류. `screen:"audit"` 피드.
- **핀/창 모델**: 헤더 드래그=팝아웃·더블클릭=핀(분할)·트레이=최소화; 상세 기본=우측 핀. `cardVal/cardToolVals/cardGrab/cardPinRight/snapTo/panels`.
- **목록 문법**: J/K/Enter·다속성 검색·열폭 드래그·공유 트랙 정렬·끝 여백/페이드.
- **토큰 문법**: `tokenParse/tokenRender/tokenType` — @멘션(알림)·#개체·!코드·바코드·날짜, PBAC 후보 게이트.
- **자동화**: `workflows/schedules` + 트리거→조건→액션; 실행 시 logEvent·실제 개체 생성. 새 모듈의 이벤트는 트리거 후보로 노출.
- **no-code 편집기**: 정책·워크플로·매핑 템플릿·프리셋 = 자연어 블록 캔버스 + 시뮬레이션 + 버전/되돌리기.
- **디자인 토큰**: `tokens/*.css` + `.console` 테마(라이트/다크). 인라인 스타일. Pretendard. 아이콘=인라인 스트로크 SVG.

## 4. 모듈 매트릭스 (레이어 정규화 · 39개 단일 행)

> 판정은 `origin/main@86a97771a76b7e770dfcf8c6c7d83fd9d70a98bf` 소스 기준이며, 표의 `소스 판정`은 **revision-bound source integration classification** 축이다. 이 축에서 `PARITY`는 새 콘솔 body와 실제 백엔드 계약이 소스에서 연결됐음을 뜻하고, named material source or integration-depth gap이 있으면 `PARTIAL`이다. This source axis is independent of ADR-0025's complete-slice/readiness evidence axis: source `PARITY` never authorizes a shipped or readiness claim, and missing runtime/deployment evidence does not by itself downgrade the source classification. 별도로 ADR-0025 complete-slice 증거가 없는 행은 배포·DB·브라우저·운영·엔터프라이즈 준비 완료로 주장할 수 없다. 합계: **5 PARITY / 25 PARTIAL / 7 MISSING / 2 N/A = 39**.

| 모듈 / screen | 레거시 서피스 | 백엔드 substrate | 새 콘솔 body | 소스 판정 | 남은 게이트 |
|---|---|---|---|---|---|
| 오버뷰 / overview | 일부 대시보드 | action-inbox·todos | registry body | PARITY | 런타임·inline 완료 증거 |
| 내 업무 / mywork | 일부 개인 큐 | action-inbox·todos | registry body | PARTIAL | 런타임·폐루프 E2E 증거 |
| 개인 수신함 / inbox | 별도 수신 흐름 | inbox·passkey | 없음 | PARTIAL | body·수령증거 E2E |
| 인사 / hr | EmployeesPage | hr·employees | 없음 | PARTIAL | body·생애주기 폐루프 |
| 채용 / recruit | 없음 | recruiting REST 없음 | 없음 | MISSING | 전체 슬라이스 |
| 조직도 / org | OrgPage·GroupAdminPage | branches·regions·sites | 없음 | PARTIAL | body |
| 인사평가 / review | 없음 | 없음 | 없음 | MISSING | 전체 슬라이스 |
| 주소록 / directory | 일부 users/employees | employees·users | 없음 | PARTIAL | body·comms 연계 |
| 근태 / att | AttendancePage | daily-work-plans | 없음 | PARTIAL | body·월마감/주52h 깊이 |
| 급여 / pay | PayrollPage | read-only draft readiness REST | 없음 | PARTIAL | 계산결과·발급 급여명세·body |
| 연차 / leave | 일부 기존 흐름 | leave REST | registry body | PARTIAL | 신청 생성·법정 타이밍/순서·E2E |
| 복리후생 / benefit | 없음 | tenant-scoped catalog REST | development REGISTRY body | PARTIAL | independent runtime/RLS closed-loop evidence·production exposure |
| 전자결재 / appr | compose 특수 라우트 | workflow/governance | registry 없음 | PARTIAL | 기안 외 함 IA·새 shell mount |
| 문서·증거 / docs | 기록물 흐름 | evidence·integrity·lifecycle | registry body | PARTIAL | 외부 signer·anchor·object-lock·TSA |
| 권한·정책 / policy | 일부 정책 화면 | Cedar authoring/sim | registry body | PARITY | live Cedar 승격은 별도 DARK 게이트 |
| 컴플라이언스 / compliance | 일부 위치동의 | compliance REST | 없음 | PARTIAL | 사용자 제품 body·다중 관할 |
| 감사 / audit | IntegrityPage/AuditFeed | integrity·audit | body 미라우팅 | PARTIAL | production sealing OFF·trust root/anchor 없음 |
| 객체 탐색 / explore | 없음 | objects·traverse | registry body | PARITY | 런타임 증거 |
| 타입 매니저 / ontology-manager | 없음 | ontology REST·27 seed types | registry body | PARITY | projected action 폭·소비자 깊이 |
| 자동화 / auto | 일부 workflow | workflow studio/runs | registry bodies 2개 | PARTIAL | Source-present schedule body/backend; runtime/browser, run-as, durable replay, and trigger-library depth remain open |
| 대시보드 / dashboard | KPI pages | reporting·KPI·quant projection | registry body | PARTIAL | Source-present body/backend; drill links are not wired into the state.screen shell |
| 인건비 분석 / laborcost | KPI/ops intelligence | financial·reporting 일부 | 없음 | PARTIAL | body·계약 연결 |
| 예측 / forecast | ForecastPage | narrow quant endpoint | 없음 | N/A (P4) | Monte-Carlo/EVT 제품은 유예 |
| 재무 / finance | FinancialPage | mounted finance-gl REST·migration 0160 | registry body | PARTIAL | period-close·CoA·보고·런타임 |
| 구매 / purchase | 일부 ERP 의도 | purchase REST 없음 | 없음 | MISSING | 전체 슬라이스 |
| 재고 / inventory | 일부 레거시 | domain/table DARK | 없음 | MISSING | REST·body |
| 자산 / asset | EquipmentPage | equipment REST | 없음 | PARTIAL | body·C-chain 연결 |
| 배차 / dispatch | DispatchPage/Map | dispatch REST | 없음 | PARTIAL | 새 body·지도 폐루프 |
| 정비 / maintenance | Maintenance/WO pages | work-orders | 없음 | PARTIAL | 새 body |
| 고객·현장 / field | Intake/field pages | customers·work-orders | 없음 | PARTIAL | 새 body·모바일 폐루프 |
| 메일 / mail | mail 화면 | comms/mail REST | main body 없음 | PARTIAL | rail→main 승격 |
| 메신저 / messenger | MessengerConsoleScreen | messenger REST | registry body + server-linked rail→main thread deep link | PARTIAL | runtime/browser evidence·remaining product parity |
| 알림 / notif | 일부 알림 | notifications | 없음 | PARTIAL | body |
| 게시판·공지 / board | 없음 | mounted notices REST | 없음 | PARTIAL | 새 body·수령확인 UI |
| 계약·조달 / contract | 일부 의도 | 3 C-chain seed types | 없음 | PARTIAL | 계약 workflow·Grant/Bid·body |
| 데이터 인제스트 / ingest | 프로토타입 | ingest REST/pipeline 없음 | 없음 | MISSING | 전체 실제 슬라이스 |
| 인력풀 / workforce | 일부 대근 | substitutions 일부 | 없음 | MISSING | 전체 제품 슬라이스 |
| 지원센터 / support | SupportPage | support REST·SLO setting | registry body | PARITY | backend four-eyes 심화·런타임 |
| 오피스 편집기 / editor | prototype shell | office governance shell | 실 editor 없음 | N/A (P3) | iframe/JWT/callback 저장 유예 |

## 5. 시그니처 데이터-상관 데모 (온톨로지 증명 — 반드시 재현)

1. **계약 수익성 환류**: ContractProfitability(C-207) → LaborCost → PayrollRun → Attendance/Substitution → WorkforcePool. 한 화면에서 상·하류 drill.
2. **인제스트→온톨로지**: 은행 거래내역(API DX-) → Voucher(전표) → Ledger; 나라장터 공고(DX-) → Bid → Contract 후보. 계약서 스캔(DX-) → Contract C- 필드 자동 매핑.
3. **결원→대근→급여→계약**: 무단결근(AT-) → 대근(AP-·WorkforcePool) → 급여 일당 반영 → 계약 인건비.
4. **감사 상관**: AuditEvent → 「개체로 이동」+「연관 이벤트(세션·체인)」 → 객체 탐색 그래프.
5. **정책 시뮬레이션**: Policy 편집 → "누가 무엇을 보는가" 시뮬 → 실제 화면 렌더 변화(persona 전환).
6. **증거 체인 목표**: 현장 사진/영상(EvidenceRecord; durable WORM/object-lock·신뢰 앵커는 미입증) → 정비오더(WO-) → 계약 이행 증빙 → 감사.

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

- 2026-07-10: **실행 큐 레인 1·2·3·5·7·9·10·17 + 16 시드 완료 (AGENTS 91–100)** — ① 창 모델 소급: leave 3섹션 카드 존(패턴 세터 — 핀·플로트·트레이·split·프리셋) → benefit·docs 단일 카드 존 재사용(appr=탭 워크스페이스 의도적 제외) ② 대시보드: 구성 위젯 {count|trend|dist} 온톨로지 쿼리 바인딩 제네릭화 + 7월 스탯 6종 라이브 실계산(DASH_CONTRACTS 단일 소스·6월=마감 스냅샷·추이=SR-205 소비) ③ 기안: 증빙 fail-closed 지출류 전체 + §68 금액 투영 패널 ④ 키보드: 급여·공고·월간 J/K/Enter(초크포인트 공용)·aria 무명 버튼 0 ⑤ WORM 뷰어: EV- 원본 봉인 페인(fail-closed)·파생 프리뷰(열람 감사)·ZIP readonly 엔트리 트리 ⑥ 미편성 결원 SLO 알림 시드(대근 편성 시 자동 해소).
- 2026-07-10: **실행 큐 잔여 소진 (AGENTS 101) — 레인 7·#11·체크인·§18.2·커버 플래너** — 인제스트 매핑 템플릿 TP-01~07 = 재사용 개체(no-code 에디터·변환 enum·사용 작업 drill·활성=개정 스테이징 four-eyes·초안→게시·보관=참조 무결성) + **계보 스트립**(소스→변환·템플릿→검증→개체 — 전 노드 drill) · **퇴사·휴직 생애주기**(사유 enum·발효일·사전점검·SoD 4단계·empSt 전환·회수 정산 6항 fail-closed·복직 전환) · **출근 체크인 심화**(기기×지오펜스 게이트·실적 타임라인 실시간·교대 스왑=결재 큐) · **§18.2**(정의 개정 발효일 구현 창·속성/관계 일몰 deprecated 30일→보관) · **커버 플래너 D+7**(승인 부재×커버 필수×편성 포워드 큐·미래 일자 대근 편성·주간 점검 예약 시드). **다음 = AGENTS 「다음」**: §4-22/23 audit → [~]13 엣지·14·15·17·18 → 대형 에픽 19–23.
