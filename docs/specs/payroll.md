# Korean Payroll Kernel Spec (G012)

Status: first regulated-kernel slice. This spec is an implementation contract, not legal/tax advice. Production payroll remains blocked until a licensed 노무사/세무사 validates the worked examples and signs the release gate.

## Goal

Build the Korean payroll foundation as a regulated, source-driven module:

- versioned, effective-dated statutory rate tables for 4대보험, minimum wage, and tax-table provenance;
- deterministic payroll draft math for employee-side deductions only where an official table row is supplied;
- golden-case tests that prove the kernel refuses estimates and is release-gated by professional validation;
- import/export readiness for sensitive payroll fields without exposing them through general HR surfaces.

## Source-of-truth order

1. Korean government/official sources: NPS, NHIS, 고용노동부/최저임금위원회, 국세청, 법제처, 근로복지공단.
2. Versioned internal rate tables with source URL, retrieval date, effective start/end date, and notes.
3. 노무사/세무사-signed golden cases that include input payslip facts, expected deductions, and source table versions.
4. Runtime payroll runs referencing the exact rate-table version and golden-case gate version.

No commercial payroll feed or blog-derived rate is allowed as a calculation source.

## Current official sources checked on 2026-06-27

- 국민연금: NPS explains workplace subscribers split the applicable yearly pension rate 50/50 between employee and employer; 2026 total rate is 9.5%, and NPS lists monthly standard-income caps of 400,000/6,370,000 won for 2025-07-01 through 2026-06-30 and 410,000/6,590,000 won for 2026-07-01 through 2027-06-30. Source: <https://www.nps.or.kr/pnsinfo/ntpsklg/getOHAF0038M0.do>
- 건강보험/장기요양: NHIS 2026 notice lists workplace health-insurance rate 7.19% with employee/employer each bearing 50%, and long-term-care rate 0.9448% applied through the NHIS formula. Source: <https://edi.nhis.or.kr/portal/images/popup/20251204_pop01longdesc.html>
- 최저임금: Minimum Wage Commission table lists 2026 hourly wage 10,320 won, daily 82,560 won, and 209-hour monthly 2,156,880 won. Source: <https://www.minimumwage.go.kr/minWage/policy/decisionMain.do>
- 근로소득 간이세액표: NTS states employers withhold monthly wage income tax using the 근로소득간이세액표 and provides HomeTax download/lookup paths. Source: <https://www.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=7862&mi=6583>
- 임금명세서: Ministry of Employment and Labor guidance for wage-statement issuance/required fields is part of the pay-statement UX contract. Source: <https://www.moel.go.kr/policy/policydata/view.do?bbs_seq=20211101053>

## Scope in this slice

### Included

- Pure Rust domain crate `mnt-payroll-domain`.
- Effective-dated 2026 rate records for employee-side deductions:
  - 국민연금 employee share: 4.75% of capped 기준소득월액 in 2026.
  - 건강보험 employee share: 3.595% of 보수월액 in 2026.
  - 장기요양 employee share: 0.4724% of 보수월액 in 2026, derived from NHIS total 0.9448% split 50/50.
  - 고용보험 실업급여 employee share: modeled as source-required 0.9% row; employer-side employment-stabilization/vocational-training varies by employer and is not guessed in this slice.
  - 산재보험: modeled as employer-only, industry-tariff-required; no employee deduction.
- Income tax handling that requires an NTS tax-table row as input. The kernel must not synthesize tax brackets from memory.
- Local-income-tax handling via the supplied withholding row/golden case, not a hidden approximation.
- Minimum-wage guard data for 2026.
- Release gate that fails unless versioned sources, at least one golden case, and licensed professional validation evidence are present.

### Excluded until the next payroll slice

- Persisted payroll-run tables and payroll REST/UI.
- Full NTS tax-table ingestion/parsing.
- Employer-side full cost calculation for all employment insurance employer subclasses and 산재 industry tariffs.
- Severance, annual-leave payout, weekly-holiday allowance, mid-period hire/termination proration, retroactive settlement, and year-end settlement. These require separate golden cases.

## Data boundaries and permissions

Payroll fields are high-sensitivity and must not be promoted into general HR/user records. Payroll import/export requires payroll-specific permission, masking, dry-run preview, audit log, and passkey confirmation for signing/approval-equivalent actions. Metrics may include counts and gate status only; no raw payroll amounts, resident-registration numbers, bank accounts, phone numbers, or addresses.

## Golden-case contract

Each golden case must include:

- `case_id`, organization/legal entity, pay period, pay date, employee category, and employment status;
- all pay items with 통상임금/taxable/insurance basis flags;
- exact NTS 간이세액표 version/row or official lookup artifact;
- expected employee deductions, employer costs if in scope, net pay, and wage-statement fields;
- source URLs/version identifiers used;
- professional reviewer kind (`labor_attorney`, `tax_accountant`, or equivalent licensed reviewer), reviewed date, and artifact hash.

A payroll calculation may be tested locally before sign-off, but production enablement must fail until the gate is satisfied.

## Release gate

Production payroll calculations are disabled unless all are true:

1. the effective-dated rate table version has at least one official source per statutory item in scope;
2. the current payroll code has at least one matching golden case for the pay type being enabled;
3. every required golden case is marked professionally validated;
4. a 노무사/세무사 validation artifact hash is stored;
5. the payroll run references immutable source and gate version ids;
6. audit, RBAC, and passkey-signing requirements are active for payroll run approval and pay-statement issuance.

## G028 production-control contract

This contract keeps payroll useful for import/staging and receipt workflows while preventing a false
"payroll is live" claim.

- **Domain ownership:** payroll calculations live in `mnt-payroll-domain`; general HR pages may show
  employment/lifecycle facts but must not own wage, bank, resident-registration, tax, insurance, or
  severance amounts.
- **Protected staging:** HR workbooks may preserve payroll/severance fields in the raw import ledger,
  but generic employee import/export can only preview masked values and canonical non-payroll fields.
- **No estimate path:** payroll drafts must require an official NTS withholding row and effective-dated
  rate table record. Missing tables, source URLs, golden cases, or professional validation fail closed.
- **Receipt workflow:** payroll/wage-statement mail may exist as an audited work-mail object only after
  a payroll processor creates the source object under payroll permission; mail is not a calculator.
- **Signing and audit:** payroll run approval, wage-statement issuance, severance/interim-settlement
  approval, and any correction that changes pay require passkey step-up, actor attribution, memo/evidence,
  and audit records that avoid raw sensitive payloads.
- **Release evidence:** production enablement requires `npm run check:payroll`, `npm run
  check:payroll-release-gate`, golden-case artifacts, and licensed labor/tax reviewer evidence. Until
  those artifacts exist, UI must present payroll as controlled staging/readiness, not as a payable run.
