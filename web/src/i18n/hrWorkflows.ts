export const approvalDocumentDeskKo = {
  title: "전자결재 문서·연동 데스크",
  description:
    "결재할 문서, 승인 완료 문서, 연차·근태·급여 반영 상태를 같은 결재 화면에서 요약합니다.",
  badge: "결재선·데이터 연동 확인",
  openLinkedScreen: "연결 화면 열기",
  overview: {
    pendingDocuments: "결재할 문서",
    completedMeta: (count: string) => `결재완료 ${count}`,
    leavePromotion: "연차 사용촉진",
    reviewNeededMeta: (count: string) => `검토 필요 ${count}`,
    remainingLeave: "잔여연차",
    leaveSummaryMeta: (used: string, accrued: string) =>
      `사용 ${used} / 발생 ${accrued}`,
    attendancePayroll: "근태·급여 연결",
    payrollSourceMeta: (count: string) => `급여 산출 원천 ${count}건`,
  },
  templates: {
    annualLeave: {
      title: "연차 신청서",
      requiredFields: ["사용일", "반차/종일", "대체인력", "결재선"],
      approvalLine: "본인 -> 부서장 -> 인사/급여",
      integration:
        "결재 완료 시 사용연차, 잔여연차, 근태 부재, 급여 산출 자료가 같은 직원 원장으로 이어집니다.",
    },
    outingBusinessTrip: {
      title: "외출·출장 신청서",
      requiredFields: ["일시", "장소", "목적", "복귀 예정"],
      approvalLine: "본인 -> 부서장",
      integration:
        "모바일/PC 출퇴근 기록과 함께 근태 예외 및 KPI 근무시간 검토 자료로 묶입니다.",
    },
    draft: {
      title: "기안서",
      requiredFields: ["제목", "시행일", "근거", "첨부"],
      approvalLine: "작성자 -> 검토자 -> 승인권자",
      integration:
        "워크플로 정책의 결재선과 문서 이력을 남겨 운영 승인 큐에서 추적합니다.",
    },
    report: {
      title: "보고서",
      requiredFields: ["보고기간", "요약", "조치사항", "첨부"],
      approvalLine: "작성자 -> 팀장 -> 임원",
      integration:
        "보고 완료 항목은 KPI와 운영 리포트에서 후속 조치 상태로 이어집니다.",
    },
    minutes: {
      title: "회의록",
      requiredFields: ["참석자", "안건", "결정사항", "담당자"],
      approvalLine: "작성자 -> 참석 부서 확인",
      integration:
        "결정사항을 담당자 업무와 전자결재 큐로 연결해 누락된 실행 항목을 줄입니다.",
    },
    expense: {
      title: "구매·지출 품의서",
      requiredFields: ["금액", "거래처", "예산항목", "증빙"],
      approvalLine: "요청자 -> 부서장 -> 재무",
      integration: "승인된 지출 근거가 구매·정산 화면의 검토 자료로 남습니다.",
    },
  },
  linkedChecks: {
    approvalLine: {
      title: "결재선 지정",
      detail:
        "문서별 작성자, 검토자, 승인권자 흐름을 워크플로 권한과 함께 검증합니다.",
    },
    leaveAttendance: {
      title: "연차·근태 반영",
      detail: (leaveCount: string, attendanceCount: string) =>
        `연차 의무 ${leaveCount}건과 근태 원천 ${attendanceCount}건을 함께 봅니다.`,
    },
    mail: {
      title: "메일·알림",
      detail:
        "사용계획서, 결재 요청, 반려 사유를 시스템 메일과 알림으로 후속 안내합니다.",
    },
  },
} as const;

export const leaveManagementKo = {
  title: "연차관리",
  description:
    "발생연차, 사용연차, 잔여연차, 사용촉진, 사용계획서 제출 상태를 근태·급여·전자결재 흐름과 함께 관리합니다.",
  loadFailed: "연차관리 데이터를 불러오지 못했습니다.",
  overview: {
    title: "연차 현황",
    description:
      "직원 원장과 연차 원장의 합계가 근태, 급여 준비, KPI 검토 자료로 이어집니다.",
    badge: "데이터 원천 동기화",
    activeEmployees: "재직 인원",
    activeMeta: (count: string) => `연차 원장 ${count}명`,
    accrued: "발생연차",
    accruedMeta: "입사일·근속기간 기준 원장",
    used: "사용연차",
    usedMeta: "승인 완료 연차와 사용 이력",
    remaining: "잔여연차",
    remainingMeta: (count: string) => `사용계획서 요청 ${count}명`,
    promotion: "사용촉진 필요",
    promotionMeta: (count: string) => `미검토 ${count}건`,
    payrollReview: "급여 반영 검토",
    payrollReviewMeta: (count: string) => `근태 연결 ${count}건`,
  },
  lifecycle: {
    title: "연차 운영 흐름",
    description: "발생, 신청, 승인, 사용촉진, 급여 반영까지 끊기지 않는 데이터 흐름입니다.",
    accrual: {
      title: "발생 기준 관리",
      detail:
        "입사일 기준 1년 미만, 1년차, 2년차, 3년차 이후 구간을 직원 원장 기준으로 분류합니다.",
    },
    approval: {
      title: "전자결재 신청",
      detail:
        "연차신청서 결재선과 필수 항목을 확인하고 승인 완료 건만 사용연차로 반영합니다.",
    },
    promotion: {
      title: "사용촉진·계획서",
      detail: (count: string) => `사용촉진 필요 ${count}건을 시스템 메일과 알림으로 추적합니다.`,
    },
    payroll: {
      title: "근태·급여 반영",
      detail: (attendanceCount: string, payrollCount: string) =>
        `근태 원천 ${attendanceCount}건과 급여 자료 ${payrollCount}건을 함께 검토합니다.`,
    },
  },
  roster: {
    title: "인원별 연차 원장",
    description: "담당 인원의 발생, 사용, 잔여, 입사일 기준 구간을 함께 확인합니다.",
    columns: {
      employee: "직원",
      department: "부서/직책",
      tenure: "입사일 기준",
      accrued: "발생",
      used: "사용",
      remaining: "잔여",
      status: "상태",
    },
  },
  notice: {
    title: "사용촉진·사용계획서 알림",
    description:
      "미제출자와 잔여연차 보유자를 시스템 메일, 개인 알림, 결재 양식으로 이어줍니다.",
    mailAction: "메일 작성",
    leaveRequestAction: "연차신청서",
    empty: "현재 사용계획서 요청 대상자가 없습니다.",
    rowMeta: (days: string, tenure: string) => `잔여 ${days} · ${tenure}`,
    requestBadge: "사용계획서 요청",
    notifyAction: "알림",
    payrollAction: "급여 준비 확인",
    summary: {
      promotion: "사용촉진 필요",
      planRequired: "계획서 요청 대상",
      payoutReview: "연차수당 검토",
    },
  },
  status: {
    hireDateMissing: "입사일 확인",
    exited: "퇴사/정산 검토",
    exhausted: "소진 완료",
    promotion: "사용촉진/계획서",
  },
  tenure: {
    missing: "입사일 확인 필요",
    underOneYear: "1년 미만 월 단위 관리",
    baseYear: (year: string) => `${year}년차 기본연차`,
    additionalYear: (year: string) => `${year}년차 가산연차 검토`,
  },
  units: {
    days: (value: string) => `${value}일`,
  },
} as const;

export const insuranceAssistKo = {
  title: "보험신고 지원",
  description:
    "입사, 퇴사, 전보, 급여 마감 자료를 바탕으로 4대보험 취득·상실·변경 신고 준비 상태를 확인합니다.",
  loadFailed: "보험신고 지원 데이터를 불러오지 못했습니다.",
  overview: {
    title: "보험신고 준비 현황",
    description:
      "직원 생애주기와 급여 준비 상태를 기준으로 신고 전 확인할 자료를 묶어 봅니다.",
    badge: "취득·상실·변경 자료 검증",
    activeEmployees: "재직 인원",
    activeMeta: (count: string) => `직원 원장 ${count}명`,
    acquisition: "취득신고 준비",
    acquisitionMeta: "입사일·사번·사업장 확인",
    loss: "상실신고 준비",
    lossMeta: "퇴사일·마지막 급여 마감 확인",
    missing: "정보 보완 필요",
    missingMeta: "누락 필드 또는 본인확인 검토",
    payrollSource: "급여 마감 원천",
    payrollSourceMeta: (count: string) => `급여 라인 ${count}건`,
    attendance: "근태 자료",
    attendanceMeta: (count: string) => `급여 연결 ${count}건`,
  },
  workflow: {
    title: "신고 업무 흐름",
    description: "인사/급여 담당자가 제출 전 필요한 자료를 빠르게 모으고 누락을 확인합니다.",
    mailAction: "안내 메일",
    linkedScreen: "연결 화면",
    acquisition: {
      title: "취득신고",
      detail:
        "신규 입사자의 사번, 입사일, 회사, 부서, 직책, 급여 원천 자료를 함께 확인합니다.",
    },
    loss: {
      title: "상실신고",
      detail:
        "퇴사자와 종료 예정자를 퇴사일, 마지막 급여 마감, 정산 검토 상태와 함께 표시합니다.",
    },
    change: {
      title: "변경·정정신고",
      detail:
        "부서, 사업장, 직책 변동이 있는 인원을 직원 생애주기 이벤트와 연결해 추적합니다.",
    },
    package: {
      title: "신고서 자료 패키지",
      detail: (payrollCount: string, attendanceCount: string) =>
        `급여 원천 ${payrollCount}건과 근태 원천 ${attendanceCount}건을 신고 전 점검합니다.`,
    },
  },
  exitWorkflow: {
    reportNote: (date: string) => `결근 경고(${date}) 기반 퇴사 확인 요청`,
    reportCreated: "퇴사 확인 케이스를 생성했습니다.",
    reportFailed: "퇴사 확인 케이스를 생성하지 못했습니다.",
    hqConfirmNote: "HQ 인사 확인",
    hrConfirmNote: "사업장 인사 확인",
    confirmDone: "퇴사 확인과 정산 패키지 생성을 반영했습니다.",
    confirmFailed: "퇴사 확인을 반영하지 못했습니다.",
    summary: {
      absenceWarnings: "결근 경고",
      pendingHr: "HR 확인 대기",
      sourceNeeded: "임금 원천 필요",
      approvalReady: "결제상신 준비",
    },
    title: "결근·퇴사·상실신고 경고",
    description:
      "결근 이상징후에서 퇴사 확인, 4대보험 상실신고, 퇴직금 정산까지 이어집니다.",
    payrollLink: "급여 정산으로 이동",
    absenceTitle: "결근 이상징후",
    absenceEmpty: "현재 열린 결근 경고가 없습니다.",
    settlementCase: "정산 케이스 보기",
    createExitCase: "퇴사 확인 케이스 생성",
    confirmationTitle: "퇴사 확인 및 상실신고 준비",
    confirmationEmpty: "진행 중인 퇴사 확인 케이스가 없습니다.",
    hrConfirm: "사업장 HR 확인",
    hqConfirm: "HQ HR 확인",
    settlementMaterial: "퇴직금/상실신고 자료 보기",
    roles: {
      site_manager: "사업장 관리자",
      employee_hr_manager: "담당 HR",
      hq_hr_manager: "HQ HR",
      payroll_manager: "급여 담당",
      insurance_loss_reporter: "4대보험 상실 신고",
    },
    status: {
      REPORTED: "HR 확인 대기",
      HR_CONFIRMED: "사업장 HR 확인",
      HQ_CONFIRMED: "HQ HR 확인",
      SETTLEMENT_READY: "정산 준비",
      APPROVAL_DRAFTED: "결제 초안",
      SUBMITTED: "결제 상신",
      REJECTED: "반려",
    },
  },
  roster: {
    title: "신고 대상자 점검",
    description: "취득, 상실, 변경, 정보보완 대상을 직원별로 검토합니다.",
    columns: {
      employee: "직원",
      dates: "입퇴사일",
      department: "부서/직책",
      report: "신고 구분",
      missing: "누락/검토",
      link: "연결",
    },
    hireDate: (date: string) => `입사 ${date}`,
    exitDate: (date: string) => `퇴사 ${date}`,
    dataReady: "자료 확인",
    employeeLedger: "직원 원장",
  },
  reports: {
    loss: "상실신고 준비",
    missing: "정보 보완",
    acquisition: "취득신고 준비",
    identityReview: "본인확인 검토",
    steady: "가입정보 유지",
  },
  fields: {
    employeeNumber: "사번",
    hireDate: "입사일",
    company: "회사",
    name: "성명",
    exitDate: "퇴사일",
    identity: "본인확인",
  },
} as const;
