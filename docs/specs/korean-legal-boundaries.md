# Korean legal/compliance boundaries for enterprise operations

Status: engineering guardrails for product planning and implementation. This is not legal advice and does not replace Korean counsel/management sign-off before launch.

## Source anchors checked on 2026-06-28

- Personal Information Protection Act / 개인정보 보호법: <https://law.go.kr/lsInfoP.do?lsId=011357>
- PIPC current privacy-policy guide list and 2026 guide: <https://www.pipc.go.kr/np/cop/bbs/selectBoardList.do?bbsId=BS217&mCode=D010030000>, <https://www.privacy.go.kr/front/bbs/bbsView.do?bbsNo=BBSMSTR_000000000049&bbscttNo=20885>
- Labor Standards Act / 근로기준법: <https://www.law.go.kr/LSW/lsInfoP.do?ancYnChk=0&lsId=001872>
- Labor Standards Act Enforcement Decree examples for worker/payroll identifying records: <https://www.law.go.kr/LSW/lsInfoP.do?efYd=20211014&lsiSeq=236083>
- MOEL wage-statement guidance/calculator: <https://www.moel.go.kr/wageCal.do>
- Location Information Act / 위치정보의 보호 및 이용 등에 관한 법률: <https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq=277359>
- EasyLaw personal-location explainer: <https://www.easylaw.go.kr/CSP/CnpClsMain.laf?ccfNo=2&cciNo=1&cnpClsNo=1&csmSeq=1702>
- Employee Retirement Benefit Security Act / 근로자퇴직급여 보장법: <https://www.law.go.kr/LSW//lsSideInfoP.do?docCls=jo&joBrNo=00&joNo=0009&lsiSeq=279829&urlMode=lsScJoRltInfoR>

## Product guardrails

1. **Purpose and minimization first.** Every personal/employee/customer/contact/location/payroll field needs a declared purpose, lawful basis/consent marker where needed, retention policy, and domain owner. Generic imports must stage unknown/sensitive fields; they must not silently write them to canonical tables.
2. **Initial login and consent.** Console/mobile onboarding must present privacy policy, personal-data collection/use terms, cookie notice where applicable, and location/work telemetry terms before collecting or using non-essential personal/location data.
3. **Sensitive domains are separate.** HR, payroll, bank/account, tax/social-insurance, resident-registration, disability/protected-status, retirement/severance, and location telemetry require domain-specific permissions, masking, audit, and retention controls.
4. **Korean labor records are first-class.** Worker roster, employment dates, worksite/position/assignment, wage ledger, wage statement, work hours, overtime/night/holiday work, leave, retirement/severance, and intermediate settlement dates must preserve calculation inputs and effective dates.
5. **Payroll is not “just employee data.”** Payroll imports/exports and wage/retirement calculations require payroll permission, legal/versioned formula sources, golden-case tests, and explicit legal-review gates before production use.
6. **Location is consent/purpose scoped.** GPS/arrival/geofence data must be tied to an explicit work purpose, consent state, collection interval, retention period, and viewer/action permission. Avoid continuous tracking by default.
7. **Signing-equivalent actions require signer attribution.** Approvals that affect pay, employment, legal commitments, asset sale/acquisition, pricing, write-off, sensitive location disclosure, or policy changes require passkey step-up before claiming the audit actor personally performed the action.
8. **Audit without overexposure.** Audit logs should prove actor, time, object, action, policy decision, step-up state, and memo/evidence references; they should not dump raw payroll, bank, resident-registration, or private location payloads into generic logs.
9. **Cross-border/cloud storage needs disclosure.** OCI object storage, logs, backups, and processors must be disclosed in the privacy policy/processor records where applicable, with deletion/export procedures.
10. **Recommendations are not decisions.** Optimization outputs for rental pricing, reserve policy, asset lifecycle, payroll, staffing, or SLA risk are recommendations until a governed workflow approves them; retain assumptions, input snapshots, and decision lineage.

## Implementation backlog links

- Initial login/privacy/cookie consent: keep wired to auth/onboarding and public storefront work.
- Data exchange/import: preserve every source cell in staging, classify sensitive fields, and require explicit target-domain mapping.
- Approval/workflow: federated approval items must expose ontology/workflow/policy context and re-authorize source-specific writes.
- Org/RBAC/PBAC/ABAC: policy should depend on tenant/group/org/department/team/position/custom role, action, object type, data class, and legal/sensitivity domain.
- HR/payroll: block production payroll calculations until legal formulas, effective-dated rate tables, golden tests, and counsel review are complete.
