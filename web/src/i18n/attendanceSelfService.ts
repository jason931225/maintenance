export const attendanceSelfServiceStrings = {
  title: "내 근태", exceptions: "내 예외", week52: "주 52시간", targetMonth: "대상 월", previousMonth: "이전 달", nextMonth: "다음 달", status: "예외 상태", empty: "표시할 예외가 없습니다.", open: "미처리", resolved: "처리됨", loading: "불러오는 중", denied: "권한 없음", loadError: "근태 정보를 불러오지 못했습니다.", retry: "다시 시도", more: "더 보기", detail: "예외 상세", close: "닫기", support: "지원 요청", unavailable: "현재 주간 근태 집계가 연결되지 않았습니다.", limit: "한도 52시간", current: "현재", projected: "예상", workDate: "발생일", occurred: "발생 시각", created: "등록 시각", evidence: "증빙", resolution: "처리 내용", acknowledged: "확인됨", overLimit: "한도 초과",
  kind: { LATE: "지각", NO_SHOW: "미출근", UNAPPROVED_OVERTIME: "미승인 연장", EARLY_LEAVE: "조퇴" },
  tone: { OK: "정상", WARN: "주의", DANGER: "위험" },
  hours: (value: number) => `${value.toFixed(1)}시간`,
  count: (value: number) => `미처리 ${String(value)}`,
} as const;
