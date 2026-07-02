import { describe, expect, it } from "vitest";

import {
  classifyDataset,
  isMappingAllowed,
  profileSourceColumn,
} from "./domainMapping";

describe("data-exchange domain mapping", () => {
  it("classifies the provided HR workbook shape as mixed HR/payroll/org/site data", () => {
    const profile = classifyDataset([
      "NO.",
      "소속",
      "사번",
      "성명",
      "근무지(주소)",
      "업무",
      "장애유무",
      "직책",
      "기본시급",
      "국민연금",
      "주민번호",
      "입사일",
      "근무지",
      "거주주소",
      "휴대폰",
      "퇴직금 중간정산",
      "은행",
      "계좌/계좌번호",
    ]);

    expect(profile.domain).toBe("mixed");
    expect(profile.domains).toEqual(
      expect.arrayContaining(["employee_hr", "payroll", "organization", "site_location"]),
    );
    expect(profile.requiresDryRun).toBe(true);
    expect(profile.unmappedHeaders).toContain("NO.");
  });

  it("blocks employee columns from machinery targets", () => {
    expect(isMappingAllowed("성명", "person.display_name")).toBe(true);
    expect(isMappingAllowed("성명", "equipment.model")).toBe(false);
    expect(isMappingAllowed("사번", "employee.employee_number")).toBe(true);
    expect(isMappingAllowed("사번", "equipment.serial")).toBe(false);
  });

  it("keeps machinery columns in the equipment domain", () => {
    expect(isMappingAllowed("모델", "equipment.model")).toBe(true);
    expect(isMappingAllowed("모델", "person.display_name")).toBe(false);
    expect(isMappingAllowed("제조사", "equipment.manufacturer")).toBe(true);
    expect(isMappingAllowed("규격", "equipment.specification")).toBe(true);
  });

  it("distinguishes worksite address from personal home address", () => {
    expect(profileSourceColumn("근무지(주소)")).toMatchObject({
      domain: "site_location",
      compatibleTargetIds: ["site.address"],
    });
    expect(profileSourceColumn("거주주소")).toMatchObject({
      domain: "employee_hr",
      compatibleTargetIds: ["person.home_address"],
    });
    expect(isMappingAllowed("근무지(주소)", "person.home_address")).toBe(false);
    expect(isMappingAllowed("거주주소", "site.address")).toBe(false);
  });

  it("treats payroll and RBAC as elevated domains", () => {
    expect(profileSourceColumn("계좌/계좌번호")).toMatchObject({
      domain: "payroll",
      sensitivity: "restricted",
    });
    expect(profileSourceColumn("권한")).toMatchObject({
      domain: "rbac",
      sensitivity: "restricted",
    });
  });

  it("classifies direct attendance headers as attendance import data", () => {
    expect(profileSourceColumn("출근시간")).toMatchObject({
      domain: "attendance_direct",
      compatibleTargetIds: ["attendance.check_in_at"],
    });
    expect(isMappingAllowed("근무일", "attendance.work_date")).toBe(true);
    expect(isMappingAllowed("근무일", "person.display_name")).toBe(false);

    const profile = classifyDataset([
      "근태 사번",
      "근태 직원명",
      "근무일",
      "출근시간",
      "퇴근시간",
      "근무분",
    ]);
    expect(profile.domain).toBe("attendance_direct");
    expect(profile.domains).toEqual(["attendance_direct"]);
    expect(profile.requiresDryRun).toBe(false);
  });
});
