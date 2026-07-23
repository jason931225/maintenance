//! Contract lock for the People & Workforce employee-create API.
//!
//! The product test graph is Buck2-owned; this source-level contract test keeps
//! the sensitive response boundary explicit when the router moves.

#[test]
fn people_create_contract_keeps_compensation_out_of_directory() {
    let openapi = include_str!("../../openapi/openapi.yaml");
    let handler = include_str!("../src/hr.rs");

    assert!(openapi.contains("operationId: createEmployee"));
    assert!(openapi.contains("operationId: getEmployeeDetail"));
    assert!(openapi.contains("$ref: '#/components/schemas/EmployeeDetail'"));
    assert!(handler.contains("get(list_employees).post(create_employee)"));
    assert!(handler.contains("JOIN employee_employment_profiles p"));
    assert!(handler.contains("employee.lifecycle.record") || handler.contains("employee.create"));
    assert!(!handler[handler.find("struct EmployeeResponse").unwrap()..handler.find("struct SetEmployeeHomeBranchRequest").unwrap()].contains("base_pay"));
    assert!(!handler[handler.find("struct EmployeeResponse").unwrap()..handler.find("struct SetEmployeeHomeBranchRequest").unwrap()].contains("phone_e164"));
}
