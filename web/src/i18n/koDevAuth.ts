/**
 * Local role-switch copy stays isolated behind the DEV-only RoleSwitcher fence.
 * The production artifact gate proves that neither this copy nor the endpoint
 * identifier ships in a release web build.
 */
export const koDevAuth = {
  copySentinel: "__DEV_AUTH_LOCAL_ROLE_COPY__",
  title: "로컬 역할 전환",
  description: "선택한 역할과 지점으로 실제 로컬 백엔드에 로그인합니다.",
  organization: "KNL 로지스틱스",
  roleLabel: "역할",
  branchLabel: "지점",
  branches: {
    changwon: "창원 본사",
    busan: "부산 지점",
  },
  roles: {
    SUPER_ADMIN: "최고 관리자",
    ADMIN: "관리자",
    EXECUTIVE: "임원",
    MECHANIC: "정비사",
    RECEPTIONIST: "접수 담당",
    MEMBER: "일반 멤버",
  },
  localRoleSwitch: "다른 계정으로 전환",
  advancedOpen: "고급 설정",
  advancedClose: "간편 설정으로 돌아가기",
  orgLabel: "조직 ID",
  branchIdsLabel: "지점 ID (쉼표로 구분)",
  organizationWideWarning: "지점 ID를 비워두면 조직 전체 범위로 로그인합니다.",
  submit: (branch: string, role: string) => `${branch} ${role} 로그인`,
  submitting: "로그인 중",
  orgRequired: "조직 ID를 입력하세요.",
  invalidIdentifiers: "조직 ID와 지점 ID는 올바른 UUID 형식이어야 합니다.",
  routeUnavailable:
    "dev-auth 백엔드가 실행 중이 아닙니다. 로컬 개발 스택을 dev-auth 빌드로 다시 시작하세요.",
  unknownSelection: "선택한 조직, 역할 또는 지점을 찾을 수 없습니다.",
  invalidSelection: "선택한 조직, 역할 또는 지점을 확인하세요.",
  forbidden: "이 로컬 역할 전환은 허용되지 않았습니다.",
  serverFailed: "로컬 백엔드에서 오류가 발생했습니다. 잠시 후 다시 시도하세요.",
  networkFailed:
    "로컬 백엔드에 연결할 수 없습니다. 개발 스택 상태를 확인하세요.",
  protocolFailed: "로컬 백엔드 응답을 처리할 수 없습니다. 개발 스택을 확인하세요.",
  failed: "역할 전환 로그인에 실패했습니다.",
} as const;
