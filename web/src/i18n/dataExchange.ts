import type {
  ImportDomain,
  Sensitivity,
  TargetField,
} from "../features/data-exchange/domainMapping";

export const dataExchangeTargetFields: readonly TargetField[] = [
  { id: "person.display_name", domain: "employee_hr", label: "성명", sensitivity: "personal", requiredPermission: "hr_import" },
  { id: "person.phone", domain: "employee_hr", label: "휴대폰", sensitivity: "personal", requiredPermission: "hr_import" },
  { id: "person.home_address", domain: "employee_hr", label: "거주주소", sensitivity: "personal", requiredPermission: "hr_import" },
  { id: "person.resident_registration_number", domain: "employee_hr", label: "주민번호", sensitivity: "restricted", requiredPermission: "hr_import" },
  { id: "employee.employee_number", domain: "employee_hr", label: "사번", sensitivity: "internal", requiredPermission: "hr_import" },
  { id: "employment.hire_date", domain: "employee_hr", label: "입사일", sensitivity: "personal", requiredPermission: "hr_import" },
  { id: "employment.termination_date", domain: "employee_hr", label: "퇴사일", sensitivity: "personal", requiredPermission: "hr_import" },
  { id: "leave.accrued_days", domain: "employee_hr", label: "발생연차", sensitivity: "personal", requiredPermission: "hr_import" },
  { id: "leave.used_days", domain: "employee_hr", label: "사용연차", sensitivity: "personal", requiredPermission: "hr_import" },
  { id: "leave.remaining_days", domain: "employee_hr", label: "잔여연차", sensitivity: "personal", requiredPermission: "hr_import" },
  { id: "protected_status.disability", domain: "employee_hr", label: "장애유무", sensitivity: "restricted", requiredPermission: "hr_import" },
  { id: "compensation.base_hourly_wage", domain: "payroll", label: "기본시급", sensitivity: "restricted", requiredPermission: "payroll_import" },
  { id: "compensation.regular_hourly_wage", domain: "payroll", label: "통상시급", sensitivity: "restricted", requiredPermission: "payroll_import" },
  { id: "compensation.allowance_regular", domain: "payroll", label: "수당(통상포함)", sensitivity: "restricted", requiredPermission: "payroll_import" },
  { id: "compensation.allowance_non_regular", domain: "payroll", label: "수당(통상 미포함)", sensitivity: "restricted", requiredPermission: "payroll_import" },
  { id: "payroll.national_pension", domain: "payroll", label: "국민연금", sensitivity: "restricted", requiredPermission: "payroll_import" },
  { id: "payroll.health_insurance", domain: "payroll", label: "건강보험", sensitivity: "restricted", requiredPermission: "payroll_import" },
  { id: "payroll.income_tax", domain: "payroll", label: "소득세", sensitivity: "restricted", requiredPermission: "payroll_import" },
  { id: "payroll.insurance_enrolled_on", domain: "payroll", label: "보험가입일", sensitivity: "restricted", requiredPermission: "payroll_import" },
  { id: "payroll.insurance_lost_on", domain: "payroll", label: "보험상실일", sensitivity: "restricted", requiredPermission: "payroll_import" },
  { id: "payroll.severance_interim_settlement_on", domain: "payroll", label: "퇴직금 중간정산", sensitivity: "restricted", requiredPermission: "payroll_import" },
  { id: "payroll.pay_day", domain: "payroll", label: "지급일", sensitivity: "restricted", requiredPermission: "payroll_import" },
  { id: "payroll.calculation_day", domain: "payroll", label: "급여산정일", sensitivity: "restricted", requiredPermission: "payroll_import" },
  { id: "payment.bank_name", domain: "payroll", label: "은행", sensitivity: "restricted", requiredPermission: "payroll_import" },
  { id: "payment.bank_account", domain: "payroll", label: "계좌/계좌번호", sensitivity: "restricted", requiredPermission: "payroll_import" },
  { id: "group.name", domain: "organization", label: "그룹명", sensitivity: "internal" },
  { id: "organization.name", domain: "organization", label: "회사명", sensitivity: "internal" },
  { id: "organization.source_name", domain: "organization", label: "소속", sensitivity: "internal" },
  { id: "org_unit.name", domain: "organization", label: "부서명", sensitivity: "internal" },
  { id: "position.title", domain: "organization", label: "직책", sensitivity: "internal" },
  { id: "job_classification.name", domain: "organization", label: "업무", sensitivity: "internal" },
  { id: "account.email_seed", domain: "rbac", label: "이메일", sensitivity: "personal", requiredPermission: "rbac_import" },
  { id: "role_assignment.role", domain: "rbac", label: "권한", sensitivity: "restricted", requiredPermission: "rbac_import" },
  { id: "site.name", domain: "site_location", label: "근무지", sensitivity: "internal" },
  { id: "site.address", domain: "site_location", label: "근무지(주소)", sensitivity: "internal" },
  { id: "site.geopoint", domain: "site_location", label: "좌표", sensitivity: "internal" },
  { id: "customer.name", domain: "customer_vendor", label: "고객명", sensitivity: "internal" },
  { id: "customer_site.name", domain: "customer_vendor", label: "현장명", sensitivity: "internal" },
  { id: "equipment.serial", domain: "machinery_equipment", label: "호기", sensitivity: "internal", requiredPermission: "equipment_import" },
  { id: "equipment.manufacturer", domain: "machinery_equipment", label: "제조사", sensitivity: "internal", requiredPermission: "equipment_import" },
  { id: "equipment.model", domain: "machinery_equipment", label: "모델", sensitivity: "internal", requiredPermission: "equipment_import" },
  { id: "equipment.specification", domain: "machinery_equipment", label: "규격", sensitivity: "internal", requiredPermission: "equipment_import" },
];

export interface DataExchangeHeaderHint {
  aliases: readonly string[];
  domain: Exclude<ImportDomain, "mixed" | "unknown">;
  sensitivity: Sensitivity;
  targetIds: readonly string[];
}

export const dataExchangeHeaderHints: readonly DataExchangeHeaderHint[] = [
  { aliases: ["주민", "주민번호", "rrn"], domain: "employee_hr", sensitivity: "restricted", targetIds: ["person.resident_registration_number"] },
  { aliases: ["성명", "이름", "name"], domain: "employee_hr", sensitivity: "personal", targetIds: ["person.display_name"] },
  { aliases: ["사번", "employee number", "employeenumber"], domain: "employee_hr", sensitivity: "internal", targetIds: ["employee.employee_number"] },
  { aliases: ["휴대폰", "전화", "phone", "mobile"], domain: "employee_hr", sensitivity: "personal", targetIds: ["person.phone"] },
  { aliases: ["거주주소", "자택주소", "home address", "homeaddress"], domain: "employee_hr", sensitivity: "personal", targetIds: ["person.home_address"] },
  { aliases: ["입사일", "퇴사일", "연차", "장애"], domain: "employee_hr", sensitivity: "personal", targetIds: [] },
  { aliases: ["시급", "수당", "급여", "국민연금", "건강보험", "소득세", "보험", "퇴직금", "지급일", "은행", "계좌"], domain: "payroll", sensitivity: "restricted", targetIds: [] },
  { aliases: ["그룹", "회사", "법인", "소속", "부서", "직책", "직위", "업무", "조직"], domain: "organization", sensitivity: "internal", targetIds: [] },
  { aliases: ["이메일", "email", "권한", "role"], domain: "rbac", sensitivity: "personal", targetIds: [] },
  { aliases: ["근무지(주소)", "현장주소", "사업장주소", "좌표", "geopoint"], domain: "site_location", sensitivity: "internal", targetIds: ["site.address"] },
  { aliases: ["근무지", "사업장", "site", "location"], domain: "site_location", sensitivity: "internal", targetIds: ["site.name"] },
  { aliases: ["고객명", "거래처", "현장명", "customer", "vendor"], domain: "customer_vendor", sensitivity: "internal", targetIds: [] },
  { aliases: ["호기", "장비", "제조사", "모델", "규격", "톤수", "equipment", "machine"], domain: "machinery_equipment", sensitivity: "internal", targetIds: [] },
];
