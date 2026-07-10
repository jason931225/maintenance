# 운영 UI / 전자결제 / 구매요청 / 그룹관리 개선 계획 요구사항

상태: 구현 전 계획 수립 전용. 제품 소스/DB/API/UI 수정, 커밋, 푸시, 머지, 배포, Release Please 조작 금지. ralplan 산출물은 pending approval에서 멈춘다.

Kanban 계획 카드: `t_56d56e06`

## 사용자 요구사항 전체

1. 접수된 내용에 대한 정비 내용 및 사진을 첨부하여 전자결제/결재를 올릴 때 결재자가 사진을 볼 수 없는 현상이 있음. 결재자가 사진을 볼 수 있게 수정.
   - 결재자/승인자가 정비 내용과 첨부 사진을 전자결제 상세/승인 화면에서 바로 볼 수 있어야 함.
   - backend가 evidence/attachment id만 주는지, preview/download/status endpoint가 필요한지 확인.
   - 접근권한 누수 없이 결재자는 읽기만 가능해야 함.

2. 배차에서 배차제어 UI에 전체 저장 버튼 추가.
   - 기존 개별 action semantics는 보존하되 변경된 제어값을 한 번에 저장하는 UX 설계.
   - P1 배차시작, 일정변경요청, 정비사 배정 등 한 줄 전체를 차지하는 큰 버튼은 공간 낭비가 크므로 작은 inline 버튼으로 축소.
   - 관리자/정비사가 한눈에 보기 편하도록 배차제어 UI를 더 compact하게 재배치.

3. 업무 허브에서 대화 스레드/메일은 중요도가 떨어지므로 메인 보드상 카드/표기 대신 좌측 메뉴탭의 메신저/메일에 빨간 말주머니/배지로 unread message/mail count만 표시.

4. 고객지원도 좌측 메뉴탭에 고객지원 문의 unread count와 open ticket count 등을 숫자 배지로 표시하여 한눈에 보이게 함.

5. 업무 허브 페이지는 개인별 업무의 모든 정보를 담되 한눈에 보이도록 compact UI로 수정.
   - 개인 업무 캘린더, 업무 중점사항/우선순위, 오늘/임박/미완료 상태를 첫 페이지에서 확인 가능해야 함.

6. 좌측 메뉴탭의 “승인”을 “전자결제”로 변경.
   - 전자결제 탭 접속 시 결재할 결재건 수, 기안/접수 등 상신하여 결재를 받아야 할 전자문서 수, 결재완료 수를 한눈에 표시.
   - 우측 상단에 종 모양 개인 알림 버튼을 추가하여 개인별 알람을 실시간/준실시간으로 확인 가능하게 함.

7. 접수 UI에서는 목표 완료일시가 필요 없음.
   - 접수 작성/수정 UI에서 목표 완료일시 입력 제거 또는 제출 payload에서 미사용 처리.
   - 배차제어에서 목표일정 지정 시 시간은 필요 없고 년/월/일 date-only만 필요.

8. 계획업무탭에서 계획작성 시 작업항목 추가를 누르면 추가 행에는 작업내용만 작성하게 수정.
   - 현재처럼 추가 작업항목마다 접수내용을 다시 고르게 하면 안 됨.
   - 부모 접수내용/대상은 최초 선택값을 공유하고, 반복 child row는 row-specific 작업내용만 입력.

9. 구매정산탭 구매요청서 refinement.
   - 케이엔엘 정비사업부만 호기수를 골라 구매요청서를 작성하는 기능 필요.
   - 다른 법인들은 지게차 관련 업종이 아니고 인도급업/제조업이므로 호기수 선택 불필요.
   - 구매유형 메뉴: 정기구매품, 단발성구매품, 기타 구매품.
   - 거래처명은 수기 입력 가능. 등록 업체는 업체명 입력 시 자동완성/불러오기 기능 추가.
   - 등록 업체에서 구매품을 구입할 때 이전 품목/단가와 비교하여 차이가 있으면 구매요청 품의작성자와 결재자가 이상징후 및 과거이력 차이를 확인 가능해야 함.
   - 비고란은 유지.
   - line item 칸 추가: 품목, 수량, 공급가액(단가), 부가세 10% 자동계산, 금액(총액).
   - 일부 구매품은 부가세가 없을 수 있으므로 부가세는 수기 수정 가능해야 함.
   - 거래처명 옆 금액(원)은 아래 입력된 품목들의 합계 금액이 자동 합산되어 표기.
   - 견적서 업로드 기능 추가. 견적서는 항상 필수 아님.
   - 정기구매품은 최초에만 견적서를 첨부하고 이후 고정 구매 시 생략 가능. 단 기존 단가와 차이가 발생하면 이상징후를 알려주고 재확인 후 견적서 업데이트가 필요.
   - 결재자는 누가 구매요청을 올렸는지 요청자를 볼 수 있어야 함.

10. 그룹관리에서 엘소의 슬러그는 `lso`가 맞고 `elso`가 아님.
   - UI/API/fixtures/data correction 필요성 점검.

11. 그룹관리에서 그룹사 리스트의 업무허브 등 여러 버튼/기능들이 차지하는 공간이 너무 큼.
   - 해당 버튼들을 compact하게 줄여 각 법인이 차지하는 row/card 높이를 줄일 필요.
   - 드롭다운, 아이콘 UI 크기 및 배치 등을 사용하여 기능 접근은 간편하고 공간은 작게.
   - 단 버튼 내용은 모두 표시되어야 함. 예: “업무 허브”가 “업무 허...”처럼 잘리면 안 됨.

## 공통 제약 및 품질 기준

- 구현 전 계획과 승인 질문까지만. 구현 시작 금지.
- GJC는 coding coordinator, Hermes Kanban은 durable board.
- 계획에는 feature/review/release/live verification 단계와 병렬화 가능/불가 영역을 구분.
- maintenance repo 규칙: PR → review/fix → merge → Release Please → live server rollout/browser UX verification.
- Release version bumps는 Release Please만 사용. 수동 version/changelog/tag 수정 금지.
- Workflow Studio/n8n 영역은 건드리지 말 것.
- UI는 compact/현대적 enterprise SaaS ergonomics, 접근성, i18n 문자열, regression tests 포함.
- 사진/첨부 visibility는 실제 결재자 화면에서 이미지가 보이는 테스트 필요.
- nav badge/notification은 기존 source API 활용, 큰 count는 99+, collapsed sidebar 대응, aria-label/i18n, hardcoded Korean in TSX 금지.
- 가능한 병렬화: dispatch UI, Work Hub/nav badges, electronic approval attachment/counts, purchase request refinement, group management compaction/slug 등 disjoint 영역. 단 shell/nav/i18n 공통 파일 충돌은 조정 필요.

## ralplan 산출물 요구

- Korean plan with affected surfaces/files/components/APIs.
- Data/API gaps and migration needs.
- UI/UX layout plan and compactness rules.
- Regression tests, CI checks, browser E2E/live verification plan.
- Rollback/risk/edge cases.
- Explicit approval questions/options.
- Pending approval에서 멈춤.
