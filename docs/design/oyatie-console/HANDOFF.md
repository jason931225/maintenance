# HANDOFF.md — 백엔드 구현자 인수인계

> 프런트(Oyatie Console)는 **온톨로지·이벤트·정책(Cedar PBAC)**을 UI로 시뮬레이션한다. 이 문서는 그 UI 계약을 실제 백엔드로 구현할 때의 데이터 모델·이벤트·정책·통합 지점을 정리한다. Palantir Foundry(온톨로지/액션/펑션) 벤치마크.

## 0. 아키텍처 원칙
- **데모/개발 스캐폴드 인벤토리 (프로덕션 반입 금지)**: 프런트 목업에만 존재하는 것 — ① **역할 전환(view-as) 카드**(사이드바 상단 · VIEWERS 5+1종): 페르소나 데모 전용. 프로덕션 = SSO/passkey 세션의 실제 principal이 Cedar 평가로 결정(전환 UI 없음, 관리자 sudo/impersonation은 별도 인가·감사 절차) ② pkAuth 1.05s 스캔 시뮬레이션(실제=WebAuthn §3) ③ 시드 데이터 전체(EMPLOYEES·rcData·threads·mails…) ④ deviceCtx 고정 ip/geo ⑤ 클라이언트 해시체인(실제=서버 tamper-evident §7) ⑥ simulateReplies 메신저 자동응답 ⑦ 인제스트 파이프라인 진행 시뮬레이션. 구현 시 이 목록은 제거·대체 대상이며 기능 플래그로도 보호한다.
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

## 6. 자동화 · 예약작업 (UI 구현됨 → 백엔드화)
- **범위(scope) = 개인 | 전사**: 전사 규칙 = 초안→게시 승인(§3.9.0) · **개인 자동화** = 본인 개체·알림에만 작용, 즉시 활성(§3.9.0-① 개인 설정 직행), 소유자 한정 노출(deny-by-omission), 실행·생성 전량 감사. 백엔드: 규칙에 `{scope, ownerPersonId}` — 개인 규칙의 액션은 소유자 리소스 범위로 정책 평가(권한 상승 금지).
- **워크플로 스튜디오**: object 타입·관계를 트리거/조건/액션 블록으로. 이벤트 발생 시 자동 실행(예: 무단결근 3회→인사 알림+소명 기안 자동생성; 연차 소진율<20% & 7/1→촉진 1차 자동발송). 벤치마크 Workato/ServiceNow Flow.
- **예약작업(cron)**: 근태 마감 리마인더·월 급여 회차 생성·보존기한 만료·연차 촉진 배치·정기 리포트. 자연어 스케줄("매월 25일")+다음 실행 미리보기+실행 로그·재시도. 벤치마크 Airflow/Temporal.
- 자동화가 생성하는 모든 object/이벤트도 §2 정책·§0 감사 이벤트를 동일 적용.

## 7. 감사 로그 (UI 구현됨 → 백엔드화)
- 모든 이벤트 object를 tamper-evident 시계열로. actor·ts·action·target·before/after·reason·ip/session·policyDecision. object/사람/정책별 필터·전문검색·시간범위·상관관계(세션/체인) drill·이상탐지(민감열람 급증·권한상승·비정상시간)·보존/불변(append-only)·서명·내보내기. 열람 자체도 감사. CEO 전용 covert 스트림 분리. 벤치마크 Splunk/CloudTrail/Workday audit.

## 8. 통합 지점 체크리스트 (새 기능마다)
(a) 관련 object에 참조 토큰·링크 칩 연결  (b) 상태 전이 시 연결 object에 역참조·이벤트  (c) 상·하류 한 번 클릭 이동. "이 기능이 어떤 object와 연결되나" 답 못하면 미완성.

## 9. 이후 구현된 오브젝트 (UI 완료 → 백엔드화)
- **AuditEvent(텔레메트리)**: who/what/when/where/how/on-what/decision/integrity + dataClass(일반·대외비·민감정보·비밀) + device·geo·browser·authMethod + Cedar decision(구동) + seq+prevHash 해시체인. 표준: NIST 800-53 AU·ISO 27001·CADF/OCSF. self-view 감사 제외 플래그.
- **WorkforcePool(비정규 인력)**: Person 서브타입 — 일용직·파트타임·알바·프리랜서·파견. contractType·rate(시급/일당/건별)·availability·skills·clearance·rating·rehireHistory·distance.
- **Substitution(대근)**: `{gap(site,role,from,to,coveredPersonId,reason), worker, ap:AP-}`. 결원→대근 AP-→배정→타임테이블 fill-in→급여(일당/시급) 산정. 미편성 SLA·알림.
- **EmployeeDay(직원-일자 개체)**: personId×date. 계획/실적 타임라인·그날 AuditEvent·급여영향·커뮤니케이션. **섹션별 dataClass 게이트**(뷰어 clearance) — 건강·상병=비밀(보건관리자·CEO 감사). 열람 자체 감사.
- **ArchiveRegister(기록물 등재)**: 외부 문서 import → `{code:IN-, title, type, keep, file, reason, status:pending}` → 기록관리자 승인 → 아카이브 확정. 원본 무결성 해시·등재 이력 감사.
- **TokenGrammar(앱 전역)**: @멘션(알림)·#개체(무알림)·!코드·바코드·날짜. 후보·링크는 PBAC 게이트(covert·clearance deny-by-omission). 백엔드: 해석 시 principal 기준 재평가.
- **Device/Context = 정책 객체(부분)**: deviceCtx 텔레메트리 완료. 남음 — 기기/네트워크/위치/시간 기반 접근 게이트, 다중 관할(§TODO) 규제 해석.
- **AttendanceState = 개체**: 근무·휴게·지각·연장·결근·승인휴가(계획 부재)·예정. 계획 vs 실적 2트랙. 월간에도 승인부재 vs 무단 구분 예정.

## 10. 데이터 인제스트 파이프라인 (Rust · 결정적 · no-AI) — UI 착수
- **Source(커넥터)=object**: `{id, kind(file|api|db|sftp|queue), name, auth, cadence, status}`. file=업로드(11종+사진·영상·ZIP·임의), api=REST 폴/웹훅. 인증·레이트리밋·스키마 드리프트·재시도.
- **IngestJob `DX-`**: `{code, source, file/endpoint, mime, srcKind(scan|native|table|structured|media|archive), docType, template, stage(uploaded→parse→sanitize→classify→map→review→committed|failed), fields[{label,raw,val,conf,tgt,status,pii,provenance}], cls, target, hash, integrityChain}`. 상태 전이=감사 이벤트.
- **파이프라인(결정적, AI 없음)**: 파싱/OCR(Rust: calamine xlsx·csv·quick-xml·serde_json·pdf-extract/lopdf·docx-rs·leptess/Tesseract·EXIF·ffmpeg 영상) → 정제(정규화·검증 Great Expectations식·PII 정규식/사전) → 분류(구조 시그니처+키워드 규칙→템플릿 매칭) → 매핑(정규식/앵커·헤더 추론·gazetteer·퍼지매칭·타입 강제·신뢰도) → 검증(저확신 human) → 적재(온톨로지 typed object + provenance/lineage + 역참조 + 감사 + 분류). 전부 템플릿·규칙·통계.
- **Template(매핑 규칙)=object**: no-code, 재사용, 버전. field→ontology 매핑·정규식·검증·신뢰도 임계.
- **Provenance/Lineage**: 값마다 (원본 문서·영역/셀/경로·변환 단계) 추적 — Foundry Data Lineage 벤치마크.
- 워크플로 트리거로 노출("새 인제스트 레코드"), 예약 폴, 임계 초과시 자동 적재.

## 11. 증거능력 보존 아카이빙 + 미디어/ZIP (WORM·무결성·연계보관성)
- **원본 불변(WORM)**: 수집 원본 write-once. `EvidenceRecord{originalHash(SHA-256), tsaToken(RFC-3161), sig, custody[], derivatives[]}`. 파생본(트랜스코딩·PDF/A·WebP·썸네일·OCR텍스트)=링크된 "열람용 사본(비증거)".
- **무결성**: 수집 즉시 해시 + append-only 해시체인(감사 seq 메커니즘 재사용) + 신뢰타임스탬프/전자서명. 재검증 API.
- **연계보관성(chain-of-custody)**: 수집자·시각·기기·IP(deviceCtx) + 모든 열람/다운로드/이관 감사(§7).
- **표준**: ISO 15489·ISO 14721 OAIS·eIDAS QTS·FRE 901/902·NIST SP 800-86·SEC 17a-4·전자문서법(전자화문서)·전자서명법. 관할별 분기(다중 관할).
- **미디어(인콘솔 뷰어/플레이어)**: 사진=EXIF/지오/기기 보존 + 이미지내 OCR; 영상=원본 보존 + 트랜스코딩(H.265) 파생 + 키프레임/장면 색인. 콘솔 내 열람·재생(원본 or 파생 스트림 · 열람 감사·PBAC·워터마크·범위 다운로드 게이트). 아카이브 최적화는 **파생본에만**.
- **ZIP/컨테이너**: 원본 아카이브 WORM 보존, 서버 안전 추출(zip-bomb·경로탈출·중첩 재귀 방어) → 엔트리 트리·메타(경로·크기·CRC)·엔트리별 해시. 엔트리는 **readonly** 각 포맷 뷰어로 열람(추출본=파생·비증거).

## 12. 인콘솔 오피스 편집기 (ONLYOFFICE/Euro-Office 헤비 포크 + 거버넌스 내장)
- **모델**: 호스트(콘솔)=저장·온톨로지·PBAC·버전·공유·감사·승인 소유; 편집기=캔버스 + **거버넌스 내장 포크**(Euro-Office 원칙 = 호스트가 스토리지·권한·공유 담당).
- **임베드**: DocumentServer editor API — config `{document:{url,key(=버전해시),fileType,permissions}, editorConfig:{mode,user,customization,callbackUrl}}` + **JWT 서명**. 콜백(status 2/6)→호스트가 불변 신버전 저장(force-save).
- **버전/롤백**: 저장마다 불변 버전(v1,v2… actor·ts·hash); **롤백**=이전 버전을 신버전으로 비파괴 복원; diff/비교.
- **PBAC**: edit/review/comment/fillForms/download/print/copy=Cedar 평가. 열람도 감사. 민감=passkey.
- **승인·협업**: 변경→기안(AP-)→결재선→종결·게시(패스키)(web/ i18n 정합); 실시간 co-edit·프레즌스·코멘트·트랙체인지·@멘션(토큰).
- **헤비 모디파이(포크) 항목** — 편집기 내부에: (a) 편집 조작 단위 감사 훅, (b) covert/비밀 섹션 서버측 렌더 차단(deny-by-omission), (c) DLP(복사·내보내기·인쇄 차단·스크린샷 워터마크), (d) 분류 라벨·컴플라이언스 게이트, (e) 콘솔 인증(passkey)·세션 통합.
- **라이선스 AGPL-3.0**(포크·서비스 임베드): 소스 공개 의무 — 컴플라이언스 검토 필요. repos: Euro-Office/DocumentServer·web-apps·core·sdkjs·desktop-sdk.

## 13. 데이터 유출 방지(DLP) · 화면 보호 · 반출 방지 — 위협 모델과 계층
### 13.1 Netflix급 DRM 연구 (directive 2026-07-10) — 왜 스크린샷이 검게 나오는가
- Netflix의 캐처 방지는 앱 코드가 아니라 **하드웨어 DRM 경로**다: EME(Encrypted Media Extensions) + Widevine **L1**/PlayReady SL3000/FairPlay — 복호된 프레임이 TEE·보호 GPU 서피스(secure video path)에만 존재해 OS 컴포지터·캐처 API에 노출되지 않음(→ 검은 화면). 소프트웨어 DRM(L3) 환경에서는 캐처 가능 → Netflix는 고해상도를 L1 기기로 제한하는 식으로 대응.
- **우리 콘솔에 대한 함의**: EME는 DRM 비디오 스트림만 보호한다 — DOM 데이터(텍스트·표)는 웹 코드로 캐처 차단 불가(기존 정직한 위협 모델 유지). Netflix급 보호를 원하면 플랫폼 계층이 필수: 엔터프라이즈 브라우저(Edge for Business/Purview — 캐처 시 검은 화면, Netskope/Island)·VDI/RBI·MDM = 계층3. 웹 계층은 익제(워터마크·blur-on-blur·앱내 클립보드)+추적까지.
- **채택 원칙 — "비통제 서피스로 데이터를 건네주지 않는다"**: 모든 내보내기·인쇄·다운로드·외부 발송 = ① 정책 스코프(can) ② 개체 상태 게이트(승인/게시만) ③ 워터마크·범위 제한 ④ 전량 감사(시도 포함 — 차단 시도=anomaly) — 게이트 없는 export 경로는 존재 금지(UI 인벤토리: 기록물 내보내기·메일 egress·감사 리포트 — 전부 게이트+감사 확인 07-10). **UX 원칙**: 게이트는 마찰 최소화 — 승인·게시된 개체의 일상 열람·내부 공유는 무마찰(감사만), 게이트 개입은 미승인·민감·외부 반출 시에만 발동(fail-closed), 차단 시 사유+해소 경로(결재 CTA·override 요청) 즉시 제시 — 보안이 UX를 크게 해치지 않도록 단계적 개입.
**정직한 위협 모델(보안 극장 금지)**: 순수 웹앱(브라우저 샌드박스)만으로 스크린샷·화면캡처·OS 복사·인쇄·사진 촬영을 **원천 차단할 수 없다**. 자기 화면 픽셀을 캡처하려는 결정한 사용자는 웹 기술로 못 막는다. **WASM도 동일 샌드박스** — OS 권한을 더 얻지 못한다(캔버스 렌더로 DOM 스크랩 억제는 되나 스크린샷은 여전). 전략 = **방지가 아니라 억제(deter)+추적(trace)+게이트(gate)+엔터프라이즈(enforce)**.
- **계층1 — 웹앱 억제/추적(콘솔 구현, 결정적 방어 아님)**: 복사·잘라내기 인터셉트+감사(입력 편집 예외)·PrintScreen 감지·인쇄 억제·**우클릭=콘솔 컨텍스트 메뉴로 대체**(브라우저 기본 메뉴 억제 — 소스 보기·다운로드 진입 차단)·**devtools 단축키(F12·⌘⌥I/J/C·⌘U) 억제+감사**·동적 워터마크(사용자ID+세션+ts)·blur-on-blur·`@media print` 마스킹 — 전부 우회 가능, 시도 자체가 감사 증거. **UX: 단계적 개입** — 승인·게시 개체 일상 열람·앱 내 드래그 참조는 무마찰, 억제는 OS 반출 시에만.\n> **정직성**: devtools 소스 보기·네트워크 스푸핑·화면 캡처는 웹 원천차단 불가 — 계층1은 억제·감사만, 완전 방어는 계층3(서버측 무결성·엔터프라이즈 브라우저·VDI/RBI·MDM·EME식 하드웨어 경로). 콘솔은 민감 데이터를 서버가 정책 평가 후에만 전송(과다 전송 금지)하도록 백엔드 설계.→**앱-내부 클립보드**(OS 클립보드 대신 앱 메모리, 콘솔 내에서만 붙여넣기) · 최고민감은 **canvas/WebGL 렌더**(DOM 텍스트 없음) · **동적 워터마크**(사용자ID+세션+ts, 민감 뷰/내보내기/인쇄 오버레이→유출 추적) · **blur-on-blur**(탭 포커스 이탈 시 마스킹) · print 인터셉트(beforeprint)·`@media print` 민감 숨김·워터마크 · 모든 열람/복사/내보내기/인쇄 시도=감사(§7)+deviceCtx.
- **계층2 — 게이트(콘솔 PBAC, 실질 방어)**: covert/민감 자료는 **인가 principal + 관리 기기 + 사내망/신뢰 컨텍스트 + passkey**에서만 렌더(deny-by-omission). 비관리·모바일·비신뢰망은 미렌더(§4.5). deviceCtx 컨텍스트 인지 접근. **웹앱이 실제 유출을 줄이는 지점.**
- **계층3 — 엔터프라이즈(실제 방지, 배포 요건)**: 진짜 스크린샷/복사/인쇄 차단은 브라우저/OS 계층에서만. **엔터프라이즈 브라우저/DLP**: MS Edge for Business+Purview(민감 라벨 기반 copy·paste·print·screenshot 차단, 캡처 시 검은 화면; OS 스니핑툴은 엔드포인트 DLP 병행) · Netskope/Island/Prisma Access Browser(브라우저 내 copy/paste/print/screenshot 차단, 스크린샷→blank). **Protected Clipboard/신뢰 경계**: 관리 앱 집합 내에서만 클립보드 이동, 외부(비관리앱·개인탭·GenAI) 붙여넣기 차단 = 사용자가 원한 "내부 복사 허용/외부 차단"은 **엔터프라이즈 브라우저 기능**(웹앱 단독 불가). **VDI/DaaS·원격 브라우저 격리(RBI)**: 픽셀만 스트리밍, 데이터가 엔드포인트에 미도달. **엔드포인트 DLP+MDM**: Defender for Endpoint·Forcepoint·Zscaler·Netskope, 관리 기기 강제. (Chromium이 클립보드 텔레메트리 통합 우수, Firefox/Brave 제한적.)
- **콘솔 입장**: 계층1·2 구현(억제+추적+게이트), 계층3을 **배포 요건**으로 문서화. 어떤 UI도 "완전 차단"을 약속하지 않는다.

## 14. 메일 백엔드 = mox (오픈소스) + 자체 프런트 UI + 엔터프라이즈 개조
- **백엔드 = mox** (github.com/mjl-/mox · Go · **MIT**): all-in-one 보안 메일 서버 — IMAP4rev2(+CONDSTORE/QRESYNC/THREAD/ACL 계정공유)·SMTP·SPF·DKIM·DMARC·MTA-STS·DANE·DNSSEC·자동 TLS(ACME)·스팸필터·**계정별 암호화 저장**·webapi/webhooks. JMAP 로드맵.
- **자체 프런트 UI**: mox 기본 webmail 대신 콘솔 **커뮤니케이션 모듈**에 자체 메일 UI(rail↔main 승격, Gmail 벤치마크). 접속: **mox webapi/webhooks(HTTP·JSON — 송수신·배달 이벤트)** 우선 + IMAP4(메일박스·동기화·ACL 공유) + SMTP submission(발송). JMAP 준비 시 전환.
- **mox 개조(오피스 편집기와 동일 철학 — 엔터프라이즈 프로덕션 기능 내장)**:
  - **감사**: 열람·발송·삭제·이동·전달·내보내기 = 콘솔 감사 이벤트(§7 · who/what/when/where/decision + deviceCtx).
  - **PBAC(Cedar)**: 메일박스·공유메일박스·위임(delegation) 접근 = 정책 평가; covert deny-by-omission; 민감 열람 passkey.
  - **컴플라이언스**: 보존정책·**법적 보존(litigation hold)**·저널링(불변 아카이브 사본)·e-discovery 검색·내보내기 → 증거 아카이빙(§11 WORM·해시) 연동.
  - **보안·DLP**: 아웃바운드 콘텐츠 스캔·첨부 차단·S/MIME·민감 라벨·전달금지/다운로드금지/워터마크(§13).
  - **온톨로지 통합**: Mail=CommObject — @멘션 알림·#개체 링크(토큰 문법), 첨부 → **데이터 인제스트(DX-)/증거(EvidenceRecord)**, 메일 ↔ 결재(AP-) ↔ 문서, 스레드 상태=개체.
- **라이선스 MIT** — 포크·개조·서비스 임베드 자유(오피스 편집기 AGPL 대비 유리). repo: mjl-/mox.

## 15. 개체 생애주기 엔진 (Draft→Archive · 거버넌스)
- **effective-dating**: 개체는 시간유효(valid-from/to) 버전 레코드. 초안=미발효 제안 버전(sandbox), 발효일에 원자 커밋→버전 N+1. as-of 조회(과거 재구성)·미래 계획. (Workday/SAP SuccessFactors/Oracle HCM 모델.)
- **상태기계**: draft→submitted→approved→published/active→revised(new version)→archived→disposed. 전이=AuditEvent(§7)+정책 평가(§4.5)+알림. 롤백=이전 버전 재발행(비파괴).
- **maker-checker/SoD(SOX)**: 기안자≠승인자, 승인 매트릭스·전결(DoA), 법인/민감=passkey.
- **사전점검(impact)**: 발효·폐지 전 의존성·규정 스캔(영향 인원·보고라인·포지션·예산·급여·진행 결재·span-of-control·orphan/cycle). blocker/warn 구분.
- **참조 무결성·정산 엔진**: 폐지는 의존 개체(직원·포지션·코스트센터·공고·자산·진행 결재) + 법정 정산(전보/전적 동의·통지 기간·근로자대표 협의·급여/4대보험/퇴직) 완료 후에만. 게이트.
- **변경 동결창**: 급여/결산 기간 락. **보관=soft(숨김)+불변 보존**(감사·법적 보존·기록물 보존기한·legal hold), 하드삭제 금지.
- 참조 구현: 조직 변경(조직도) — DESIGN §3.9.2. 벤치마크: Workday·SAP SuccessFactors·Oracle HCM·SOX·ISO 15489·EDRM.

## 16. 내부통제·가드레일 엔진 (Preventive Controls)
- **control point**: 액션마다 preflight 평가 = {authority(Cedar 권한·clearance·전결), checklist(self·peer), approval(SoD/DoA), egress(state+export perm+분류)}. **fail-closed**(기본 거부).
- **Checklist=object**: `{id, kind(self|peer), items[{label,required,checked,by,at}], attestation(sig·ts)}`. 필수 미완료 시 전이 차단. 버전·감사.
- **egress gate**: 외부 발송/내보내기/인쇄/공유 = resource.state ∈ {approved,published} && principal has export perm && 분류 허용(대외비=추가 승인). 위반=차단+감사+알림.
- **detective**: 무권한 시도·비승인 egress·SoD 위반 시도 = AuditEvent(anomaly)+컴플라이언스 알림. override=사유+상위 승인+감사.
- 벤치마크: COSO·SOX ITGC·three-lines-of-defense·NIST 800-53 AC·four-eyes. §3.9 생애주기·§4.5 PBAC·§13 DLP와 결합. 참조 사고: 미검토 계약 외부 발송(§DESIGN 3.10.1).

## 17. 엔터프라이즈 SaaS 표준 계약 (Security · Data · Observability — 백엔드 요건)
> 원칙: 표준·인증 = **개체(FW-)**, 통제(control) = 콘솔의 실기능이 증거(evidence)로 매핑 (Vanta/Drata/AWS Audit Manager 벤치마크). UI = 컴플라이언스 모듈 FW- 행.
- **SaaS 신뢰**: SOC 2 Type II(Trust Services CC) · ISO 27001 + 27017(클라우드)/27018(PII) · 상태 페이지·uptime SLA. **테넌시 격리**(테넌트별 논리 격리 + 암호화 키 분리), **SSO**(SAML 2.0/OIDC) + **SCIM 2.0** 프로비저닝, session 관리(만료·동시성·기기 바인딩 — deviceCtx 연동).
- **데이터 취급**: 분류 4등급(공개/일반/대외비/민감·비밀 — 기존 auditClassify 연동) · 암호화 at-rest(AES-256·KMS envelope·키 로테이션)/in-transit(TLS 1.3·mTLS 내부) · 레지던시·국외이전(SCC — §PII 섹션) · 보존/파기(§3.9 폐기 게이트=구현) · 백업(암호화·복원 리허설).
- **보안·IP 보호**: SDLC(SAST/DAST·의존성 스캔·secrets 스캔) · 취약점 관리(SLA: critical 24h) · 연 1회+ 펜테스트 · IP = 분류 라벨+워터마크+egress 게이트+DLP(§13) — 영업비밀·저작물 표시는 문서 개체 속성.
- **위협 완화**: 위협 모델링(STRIDE, 신규 기능 게이트) · WAF·rate limiting·bot 차단 · 이상 탐지(기존 anomaly 칩 = UI 계약) · **IR**(NIST 800-61: 런북·심각도 매트릭스·포렌식=감사 체인·고객 통지 SLA 72h) · 공급망(SBOM·서명 배포).
- **텔레메트리·관측성·감사성**: **OpenTelemetry**(traces/metrics/logs 단일 파이프라인) · SLO/SLI(가용성·지연·오류율) + 오류 예산 · 감사 = append-only + seq 해시체인(구현) + **OCSF/CADF 정합**(구현) + **SIEM export**(Splunk/CloudTrail 포맷 — 감사 화면 내보내기 = UI 계약) · tamper-evident 서명·외부 앵커링(TSA)은 백엔드.
- 매핑 원칙: 각 FW- 개체의 kv = {통제 → 콘솔 증거(감사 해시체인·Cedar·egress·passkey·WORM·스테이징)} — 문서가 아니라 **작동하는 기능이 증거**.

## 18. 온톨로지 엔진 (single engine, multiple consumers — Foundry/Maven · UI 착수)
> 프런트 `ONT_TYPES()` = 단일 타입 레지스트리(typed 속성 스키마 + 관계 유형 + 액션 + 분석). 모든 표면이 이 하나를 참조한다. 백엔드는 이를 **온톨로지 서비스**로 구현한다 — 모듈마다 스키마 재정의 금지.
- **ObjectType 레지스트리**: `{typeId, label, version, stage(draft→active→archived), propSchema[{key, dataType(text|money|percent|date|enum|lifecycle|person|number), options?, unit?, derived?}], linkTypes[{key(rel), fromType, toType, cardinality(1:1|1:N|N:M)}], actions[{key, label, fn(=writeback/navigate)}], analytics[{key, label, expr}]}`. 편집 = 개정 스테이징(§15 — 활성=four-eyes 승인 v+1, 초안=직행) · `state.ontTypeDefs` 오버레이 = 서버측 typeDef 변경분.
- **Object 인스턴스 스토어**: `{id, typeId, code, label, props{key→value(typed·검증)}, links[{rel, toId}]}`. 그래프 = 인스턴스+링크 조인. 링크는 typed(linkType 참조) — 자유 문자열 rel 금지(마이그레이션 대상). provenance(§10 인제스트)·lifecycle(§15)·audit(§7) 결합.
- **Actions = writeback 함수(Palantir Actions)**: 개체 타입에 바인딩된 서버측 함수 — 개체 mutate 또는 파생 개체 생성. 전량 정책 평가(§2)+감사(§7)+가드레일(§16). 프런트 `ogActionRun`이 UI 계약(감사 이벤트·CTA). 예: 계약「갱신 검토 기안」→AP- 생성, 근태「대근 편성」→Substitution+AP-.
- **Analytics = 파생 속성(계산)**: 산식(`expr`)을 집계 쿼리로 컴파일(예: 마진 = 계약금 − 인건비 − 간접비, 인건비 = Σ PayItem). 결과는 읽기 전용 속성으로 노출(대시보드 AN-·개체 카드). 실데이터 파생(급여·근태 집계)은 백엔드.
- **소비자(재구현 금지)**: 객체 탐색 그래프(속성·액션·분석·관계 패널) · 정책(principal/resource = 타입·속성 선택 — 타입 추가 시 자동 후보) · 워크플로 빌더(트리거/조건/액션 블록 = 타입·속성·액션 바인딩) · 모듈 서피스(행 = 타입별 인스턴스 쿼리 — MOD_SCREENS 하드코딩을 엔진 쿼리로 대체 예정). 벤치마크: Palantir Foundry Ontology(Object Types·Link Types·Actions·Functions)·Maven·OPA/Cedar entity store.

### 18.1 전면 온톨로지 커버리지 (directive 2026-07-09 — "literally everything is ontology")
- **모든 도메인 타입이 엔진 개체**: 결재·문서·기록물·인제스트·정책·컴플라이언스·규제 파라미터·표준 프레임워크·감사·분석·예측·자동화·메신저·메일·알림·직원·계약·거래처·사업장·자산·재고·생산 파이프라인·급여·근태·연차·복리후생·조직·평가·채용공고·지원자·전표·구매·정비·현장·공지·지원 티켓·시리즈·인력풀·편성 — 전부 `ONT_TYPES()`에 typed props·linkTypes(카디널리티)·actions·analytics로 정의. 어느 화면의 명사든 엔진 타입 정의를 가진다.
- **레지스트리·사용자 타입 자동 합류**: `ONT_TYPES()`는 `base`(큐레이트) + `state.ontTypes`(레지스트리·사용자 제안 OT-) 를 병합 — base에 없는 타입은 `ONT_SCHEMA_DEF` 기반 기본 스키마 파생(속성명→dataType 추론). 결과: **신규 타입도 즉시 관계·분석·속성 편집 및 그래프/정책/워크플로 활용 가능**(engineOn=true). 하드코딩 없이 사용자 저작 타입이 1급.
- **컴플라이언스 = 온톨로지**: 컴플라이언스(의무 CP-)·규제 파라미터(RG-)·표준 프레임워크(FW-) 3 타입. 모듈 행 → `_modRowType`가 `en` 「구분」으로 타입 분기. 근거 규제·대상 개체·이행 기안·증거·감시 워크플로가 typed 링크. 정책 resource·워크플로 트리거로 자동 노출.

### 18.2 CRUD·거버넌스 (새 개체·새 타입·수정·보관 — 전부 생애주기)
- **정의 변경 = 무중단·무파괴**: 관계 유형·분석·속성 추가/수정은 활성 타입에서 **개정 스테이징**(§15) 강제 — `ontDefPend`(초안 대기) → four-eyes 「적용 승인」 → v+1 발효. 초안 타입만 직행(§3.9.0 ③). **breaking change 방지**: 승인 없이는 현행 정의(전 소비자가 쓰는) 불변.
- **구현 창(implementation window) + 일몰(sunset)**: 승인은 명시적 **발효일(effective-date)** 동반(즉시/미래) — 미래 발효 = 예고. 링크/속성 **제거·대체**는 하드삭제 금지, deprecated 표시 + **일몰 창**(유예) 후 보관. as-of 조회로 과거 정의 재구성. 스키마 파괴적 변경도 초안→승인→구현/일몰 창을 반드시 통과.
- **카디널리티 typed 메타**: linkType = `{rel, fromType, toType, cardinality(1:1|1:N|N:1|N:N)}`. 프런트 관계 유형 편집기에 카디널리티 select + 칩 배지. 백엔드 참조무결성·조인 기수 검증 근거.

## 19. 구성 가능한 콘솔/대시보드 — 인콘솔 에디터 (directive 2026-07-09 · UI 착수)
> 원칙: 콘솔 자체가 **온톨로지 위에서 재구성 가능한 캔버스**. 컴포넌트 추가·편집, 테이블 열 추가/재정렬, 컴포넌트 거동(자유 오버레이·모달·핀 분할·최소화·그리드) 선택 — 전부 no-code, **구성(config)=버전·승인·감사되는 온톨로지 개체**. Retool과의 결정적 차이: config가 벤더 종속 JSON이 아니라 **거버넌스되는 개체**(초안→승인→발효, 롤백·as-of).
- **컴포넌트 모델**: `DashComponent{id, type(table|stat-bar|card|chart|timeline|kanban|graph|panel), bindTypeId(온톨로지 타입), query(필터·정렬·집계), columns[{key, label, dataType, width, sortable, visible, order}], behavior(grid|pin-split|free-overlay|modal|minimized), pos/size, pbac, version}`. 바인딩 = ONT 타입 인스턴스 쿼리(§18 스토어). 열 = 타입 propSchema에서 선택·추가.
- **에디터 상호작용**: 「구성」 토글 → 컴포넌트 팔레트(타입 바인딩) 드롭 · 컴포넌트 hover=편집(열 추가/숨김/재정렬·거동 선택) · 그리드/12-col 스냅 · 프리셋(§CARD_PRESETS 계승) · 시뮬레이션·되돌리기. 거동 선택 = 기존 핀/창 모델(자유 오버레이·모달·핀 분할·최소화) 재사용 — 신규 문법 아님.
- **거버넌스**: 레이아웃/컴포넌트/열 변경 = §3.9.0 저장·적용 audit 대상 — 개인 뷰(화이트리스트 ①, 직행) vs 공유·배포 레이아웃(초안→개편 결재→발효). PBAC: 컴포넌트·열·액션이 정책 평가(민감 열=deny-by-omission). 전이 감사.
- **벤치마크(best-in-class ≥8, 2025–26 연구)**: **Retool**(100+ 컴포넌트·12-col 그리드·JS 바인딩·300+ 템플릿 · config=JSON=lock-in 비판 → 우리는 개체·이식성) · **Appsmith**(오픈소스·64-grid 정밀·JS anywhere · 갭=행 커스터마이징·라벨 인쇄 부재 → 우리는 포함) · **ToolJet**(80+ 통합·RBAC·감사·AI 스캐폴드) · **Budibase**(내장 DB·열 정의→폼/뷰 자동생성) · **Superblocks**(거버넌스·엔터프라이즈·AI 에이전트 Clark) · **UI Bakery**(70+ 컴포넌트·네이티브 스케줄러) · **Windmill**(스크립트 우선) · **Microsoft Power Apps**(M365/Azure 거버넌스) · **OutSystems/Mendix**(엔터프라이즈 low-code·앱별 환경) · **Palantir Foundry Workshop**(온톨로지 바인딩 위젯 — 우리 north star). 공통 교훈: 컴포넌트 라이브러리·데이터 바인딩·그리드 캔버스·거동/열 config·RBAC·버전/감사. 우리 차별점 = **config가 거버넌스되는 온톨로지 개체**(초안→승인→발효·일몰·as-of·전 소비자 반영).
- **잔여(백엔드/후속)**: 컴포넌트 스토어 영속·공유 레이아웃 배포 결재·차트/타임라인/칸반 바인딩 제네릭화·모듈 서피스를 엔진 쿼리 소비로 전환(MOD_SCREENS 하드코딩 제거).

## 20. 전면 CRUD 감사 매트릭스 (directive 2026-07-09 — "모든 보이는 것은 UI로 생성·변경·제거 가능해야 한다")
> 원칙: 화면의 모든 요소에 대해 "이걸 UI에서 어떻게 만들고, 바꾸고, 없애는가"가 답 가능해야 한다 — placeholder 금지. **초안 단계 = 직행 편집(§3.9.0-③) · 초안 이후 데이터 변경 = 오버라이드(사유 필수 + four-eyes 승인 + 이전 값 감사 보존 · §3.10)** — 전 개체 공통.
- **개체(인스턴스)**: C=typed 생성 위저드(`objNewOpen` — 탐색 「+ 새 개체」 Enter·타입 카드 「+ 새 인스턴스」; 타입 스키마 필드·초기 관계·fail-closed 이름) · R=개체 카드/그래프/모듈 상세 · U=초안 OB-→위저드 직행, 초안 이후→**데이터 오버라이드**(`objOverrides` pending→발효, 카드 warn 배너 적용 승인/철회, `ONTOLOGY_GRAPH` 발효분 머지) · D=생애주기 보관/폐기 게이트(하드삭제 금지).
- **타입**: C=「+ 타입 제안」(`ontTypeAdd` 초안→검토→활성) · R=범례·타입 카드 · U=속성(`ontAttrAdd`)·관계(카디널리티)·분석 — 활성=개정 스테이징 v+1, 초안=직행 · D=보관 게이트(인스턴스 마이그레이션·재바인딩).
- **관계**: C=카드 코드 입력/드래그 드롭(`objLinkAdd`)·위저드 초기 링크 · U/D=`objLinkRemove`(이력 감사 보존). 관계 유형: 타입 카드 편집기.
- **분석·예측·인사이트**: C=타입 분석 산식(`ontAnaAdd`) + 인스턴스는 위저드(분석 OT-11·예측 OT-32 — 근거 체인=관계) · U=스테이징/오버라이드 · D=보관.
- **워크플로·예약**: C=블록 빌더(전사=초안→게시·개인=즉시 활성) · U=편집→개정 스테이징 v+1 · D=보관(트리거 중지·이력 보존).
- **정책(Cedar)**: C=no-code 캔버스 초안 · U=규칙 편집 v+1 · D=초안 전환/시행 해제 — 시뮬 동반.
- **화면 구성**: C/U/D=「구성」 모드(열·스탯·거동, 개인=직행·공유=팀 배포 결재).
- **데이터(값)**: C=인제스트(DX- 파이프라인)·기안 구조화 필드 · U=**오버라이드**(위 공통) · D=보존기한 처분(폐기 게이트).
- **잔여 갭(레지스터)**: 시리즈 인스턴스 값 직접 입력 · 모듈 행 자체의 인라인 생성(현재 도메인 액션 경유 — 체인 원칙상 의도) · 조직 트리 요소 삭제 가드 · 대시보드 위젯 추가.
