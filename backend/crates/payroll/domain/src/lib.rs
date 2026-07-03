//! Korean payroll domain kernel.
//!
//! This crate intentionally contains pure, source-versioned data and guardrail
//! math only. It must not call external services, read environment variables, or
//! silently estimate tax-table values. Production payroll release remains gated
//! by licensed 노무사/세무사 validation artifacts.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_kernel_core::KernelError;
use time::Date;
use time::macros::date;

const PPM_DENOMINATOR: i128 = 1_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OfficialSource {
    pub authority: &'static str,
    pub title: &'static str,
    pub url: &'static str,
    pub retrieved_on: Date,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EffectivePeriod {
    pub from: Date,
    pub to_exclusive: Option<Date>,
}

impl EffectivePeriod {
    #[must_use]
    pub const fn new(from: Date, to_exclusive: Option<Date>) -> Self {
        Self { from, to_exclusive }
    }

    #[must_use]
    pub fn contains(self, day: Date) -> bool {
        day >= self.from && self.to_exclusive.is_none_or(|to| day < to)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContributionCode {
    NationalPension,
    HealthInsurance,
    LongTermCare,
    EmploymentUnemployment,
    IndustrialAccident,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContributionBasis {
    MonthlyStandardIncome,
    MonthlyRemuneration,
    IndustryTariff,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoundingRule {
    FloorWon,
    ExternalTable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContributionRate {
    pub code: ContributionCode,
    pub period: EffectivePeriod,
    /// Parts per million of the contribution basis. 47,500 ppm = 4.75%.
    pub employee_ppm: Option<u32>,
    /// Parts per million of the contribution basis when a fixed employer share
    /// exists. `None` means employer cost needs a separate official tariff.
    pub employer_ppm: Option<u32>,
    pub basis: ContributionBasis,
    pub rounding: RoundingRule,
    pub source: OfficialSource,
    pub notes: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonthlyBaseLimit {
    pub period: EffectivePeriod,
    pub minimum_won: i64,
    pub maximum_won: i64,
    pub source: OfficialSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MinimumWageRate {
    pub period: EffectivePeriod,
    pub hourly_won: i64,
    pub daily_8h_won: i64,
    pub monthly_209h_won: i64,
    pub source: OfficialSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NtsWithholdingTaxRow {
    pub table_version: &'static str,
    pub monthly_income_tax_won: i64,
    pub local_income_tax_won: i64,
    pub source: OfficialSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayrollDraftInput {
    pub pay_date: Date,
    pub monthly_remuneration_won: i64,
    pub pension_standard_monthly_income_won: Option<i64>,
    pub nts_tax_row: Option<NtsWithholdingTaxRow>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeductionLine {
    pub code: DeductionCode,
    pub label_ko: &'static str,
    pub amount_won: i64,
    pub source_url: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeductionCode {
    NationalPension,
    HealthInsurance,
    LongTermCare,
    EmploymentInsurance,
    IncomeTax,
    LocalIncomeTax,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayrollDraft {
    pub pay_date: Date,
    pub gross_wage_won: i64,
    pub taxable_income_tax_table_version: &'static str,
    pub lines: Vec<DeductionLine>,
    pub total_employee_deductions_won: i64,
    pub net_pay_won: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeverancePayInput {
    pub hire_date: Date,
    pub exit_date: Date,
    pub average_wage_period_start: Date,
    pub average_wage_period_end: Date,
    pub average_wage_calendar_days: i64,
    pub average_wage_total_won: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeverancePayDraft {
    pub hire_date: Date,
    pub exit_date: Date,
    pub service_days: i64,
    pub average_wage_period_start: Date,
    pub average_wage_period_end: Date,
    pub average_wage_calendar_days: i64,
    pub average_wage_total_won: i64,
    pub average_daily_wage_milliwon: i64,
    pub statutory_30_day_wage_won: i64,
    pub severance_pay_won: i64,
    pub source: OfficialSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfessionalReviewerKind {
    LaborAttorney,
    TaxAccountant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoldenPayrollCase {
    pub case_id: String,
    pub rate_table_version: String,
    pub professionally_validated: bool,
    pub expected_total_employee_deductions_won: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfessionalValidation {
    pub reviewer_kind: ProfessionalReviewerKind,
    pub reviewed_on: Date,
    pub artifact_sha256: String,
    pub reviewer_reference: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayrollReleaseGateInput {
    pub rate_table_version: String,
    pub official_source_urls: Vec<String>,
    pub golden_cases: Vec<GoldenPayrollCase>,
    pub professional_validation: Option<ProfessionalValidation>,
}

#[must_use]
pub const fn payroll_sources_verified_on() -> Date {
    date!(2026 - 06 - 27)
}

#[must_use]
pub const fn moel_retirement_pay_source() -> OfficialSource {
    OfficialSource {
        authority: "Ministry of Employment and Labor",
        title: "Retirement pay average wage formula",
        url: "https://www.moel.go.kr/faq/faqView.do?seqRepeat=89",
        retrieved_on: date!(2026 - 07 - 03),
    }
}

#[must_use]
pub const fn nhis_qualification_loss_form_source() -> OfficialSource {
    OfficialSource {
        authority: "National Health Insurance Service",
        title: "4-insurance workplace subscriber qualification loss report",
        url: "https://www.nhis.or.kr/static/html/wbdb/f/wbdbf0201.html",
        retrieved_on: date!(2026 - 07 - 03),
    }
}

#[must_use]
pub const fn nps_source() -> OfficialSource {
    OfficialSource {
        authority: "국민연금공단",
        title: "사업장가입자 보험료율 및 기준소득월액 상·하한액",
        url: "https://www.nps.or.kr/pnsinfo/ntpsklg/getOHAF0038M0.do",
        retrieved_on: payroll_sources_verified_on(),
    }
}

#[must_use]
pub const fn nhis_source() -> OfficialSource {
    OfficialSource {
        authority: "국민건강보험공단",
        title: "2026년도 보험료율 인상 안내",
        url: "https://edi.nhis.or.kr/portal/images/popup/20251204_pop01longdesc.html",
        retrieved_on: payroll_sources_verified_on(),
    }
}

#[must_use]
pub const fn nts_source() -> OfficialSource {
    OfficialSource {
        authority: "국세청",
        title: "근로소득 원천징수방법(간이세액표)",
        url: "https://www.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=7862&mi=6583",
        retrieved_on: payroll_sources_verified_on(),
    }
}

#[must_use]
pub const fn minimum_wage_source() -> OfficialSource {
    OfficialSource {
        authority: "최저임금위원회",
        title: "연도별 최저임금 결정현황",
        url: "https://www.minimumwage.go.kr/minWage/policy/decisionMain.do",
        retrieved_on: payroll_sources_verified_on(),
    }
}

#[must_use]
pub fn statutory_contribution_rates() -> Vec<ContributionRate> {
    vec![
        ContributionRate {
            code: ContributionCode::NationalPension,
            period: EffectivePeriod::new(date!(2026 - 01 - 01), Some(date!(2027 - 01 - 01))),
            employee_ppm: Some(47_500),
            employer_ppm: Some(47_500),
            basis: ContributionBasis::MonthlyStandardIncome,
            rounding: RoundingRule::FloorWon,
            source: nps_source(),
            notes: "2026 total 국민연금 rate is 9.5%, split equally for workplace subscribers.",
        },
        ContributionRate {
            code: ContributionCode::HealthInsurance,
            period: EffectivePeriod::new(date!(2026 - 01 - 01), Some(date!(2027 - 01 - 01))),
            employee_ppm: Some(35_950),
            employer_ppm: Some(35_950),
            basis: ContributionBasis::MonthlyRemuneration,
            rounding: RoundingRule::FloorWon,
            source: nhis_source(),
            notes: "2026 workplace 건강보험 total 7.19%, split 50/50.",
        },
        ContributionRate {
            code: ContributionCode::LongTermCare,
            period: EffectivePeriod::new(date!(2026 - 01 - 01), Some(date!(2027 - 01 - 01))),
            employee_ppm: Some(4_724),
            employer_ppm: Some(4_724),
            basis: ContributionBasis::MonthlyRemuneration,
            rounding: RoundingRule::FloorWon,
            source: nhis_source(),
            notes: "2026 장기요양 total 0.9448% of remuneration, represented as a 50/50 employee/employer split.",
        },
        ContributionRate {
            code: ContributionCode::EmploymentUnemployment,
            period: EffectivePeriod::new(date!(2026 - 01 - 01), Some(date!(2027 - 01 - 01))),
            employee_ppm: Some(9_000),
            employer_ppm: Some(9_000),
            basis: ContributionBasis::MonthlyRemuneration,
            rounding: RoundingRule::FloorWon,
            source: OfficialSource {
                authority: "법제처/고용노동부",
                title: "고용보험 실업급여 보험료율",
                url: "https://www.law.go.kr/LSW/lsInfoP.do?efYd=20251001&lsiSeq=280527#0000",
                retrieved_on: payroll_sources_verified_on(),
            },
            notes: "Employee unemployment-insurance share only; employer vocational/stabilization add-ons require separate company-size rules.",
        },
        ContributionRate {
            code: ContributionCode::IndustrialAccident,
            period: EffectivePeriod::new(date!(2026 - 01 - 01), Some(date!(2027 - 01 - 01))),
            employee_ppm: Some(0),
            employer_ppm: None,
            basis: ContributionBasis::IndustryTariff,
            rounding: RoundingRule::ExternalTable,
            source: OfficialSource {
                authority: "근로복지공단/고용노동부",
                title: "산재보험 업종별 보험료율 고시",
                url: "https://total.comwel.or.kr/",
                retrieved_on: payroll_sources_verified_on(),
            },
            notes: "산재보험 is employer-side and industry-tariff based; this kernel must not guess it.",
        },
    ]
}

#[must_use]
pub fn national_pension_base_limits() -> Vec<MonthlyBaseLimit> {
    vec![
        MonthlyBaseLimit {
            period: EffectivePeriod::new(date!(2025 - 07 - 01), Some(date!(2026 - 07 - 01))),
            minimum_won: 400_000,
            maximum_won: 6_370_000,
            source: nps_source(),
        },
        MonthlyBaseLimit {
            period: EffectivePeriod::new(date!(2026 - 07 - 01), Some(date!(2027 - 07 - 01))),
            minimum_won: 410_000,
            maximum_won: 6_590_000,
            source: nps_source(),
        },
    ]
}

#[must_use]
pub fn minimum_wage_rates() -> Vec<MinimumWageRate> {
    vec![MinimumWageRate {
        period: EffectivePeriod::new(date!(2026 - 01 - 01), Some(date!(2027 - 01 - 01))),
        hourly_won: 10_320,
        daily_8h_won: 82_560,
        monthly_209h_won: 2_156_880,
        source: minimum_wage_source(),
    }]
}

pub fn contribution_rate_on(
    code: ContributionCode,
    day: Date,
) -> Result<ContributionRate, KernelError> {
    statutory_contribution_rates()
        .into_iter()
        .find(|rate| rate.code == code && rate.period.contains(day))
        .ok_or_else(|| KernelError::validation(format!("missing payroll rate {code:?} for {day}")))
}

pub fn national_pension_limit_on(day: Date) -> Result<MonthlyBaseLimit, KernelError> {
    national_pension_base_limits()
        .into_iter()
        .find(|limit| limit.period.contains(day))
        .ok_or_else(|| KernelError::validation(format!("missing pension base limit for {day}")))
}

pub fn minimum_wage_on(day: Date) -> Result<MinimumWageRate, KernelError> {
    minimum_wage_rates()
        .into_iter()
        .find(|rate| rate.period.contains(day))
        .ok_or_else(|| KernelError::validation(format!("missing minimum wage for {day}")))
}

pub fn build_employee_payroll_draft(input: PayrollDraftInput) -> Result<PayrollDraft, KernelError> {
    if input.monthly_remuneration_won < 0 {
        return Err(KernelError::validation(
            "monthly remuneration must be non-negative",
        ));
    }
    let tax_row = input.nts_tax_row.ok_or_else(|| {
        KernelError::validation(
            "NTS withholding tax table row is required; payroll must not estimate income tax",
        )
    })?;
    if tax_row.monthly_income_tax_won < 0 || tax_row.local_income_tax_won < 0 {
        return Err(KernelError::validation(
            "NTS tax row amounts must be non-negative",
        ));
    }

    let pension_limit = national_pension_limit_on(input.pay_date)?;
    let pension_basis = input
        .pension_standard_monthly_income_won
        .unwrap_or(input.monthly_remuneration_won)
        .clamp(pension_limit.minimum_won, pension_limit.maximum_won);

    let pension = employee_amount(
        contribution_rate_on(ContributionCode::NationalPension, input.pay_date)?,
        pension_basis,
    )?;
    let health = employee_amount(
        contribution_rate_on(ContributionCode::HealthInsurance, input.pay_date)?,
        input.monthly_remuneration_won,
    )?;
    let long_term_care = employee_amount(
        contribution_rate_on(ContributionCode::LongTermCare, input.pay_date)?,
        input.monthly_remuneration_won,
    )?;
    let employment = employee_amount(
        contribution_rate_on(ContributionCode::EmploymentUnemployment, input.pay_date)?,
        input.monthly_remuneration_won,
    )?;

    let lines = vec![
        deduction(
            DeductionCode::NationalPension,
            "국민연금",
            pension,
            nps_source().url,
        ),
        deduction(
            DeductionCode::HealthInsurance,
            "건강보험",
            health,
            nhis_source().url,
        ),
        deduction(
            DeductionCode::LongTermCare,
            "장기요양보험",
            long_term_care,
            nhis_source().url,
        ),
        deduction(
            DeductionCode::EmploymentInsurance,
            "고용보험",
            employment,
            contribution_rate_on(ContributionCode::EmploymentUnemployment, input.pay_date)?
                .source
                .url,
        ),
        deduction(
            DeductionCode::IncomeTax,
            "근로소득세",
            tax_row.monthly_income_tax_won,
            tax_row.source.url,
        ),
        deduction(
            DeductionCode::LocalIncomeTax,
            "지방소득세",
            tax_row.local_income_tax_won,
            tax_row.source.url,
        ),
    ];
    let total_employee_deductions_won =
        lines
            .iter()
            .map(|line| line.amount_won)
            .try_fold(0_i64, |total, amount| {
                total
                    .checked_add(amount)
                    .ok_or_else(|| KernelError::validation("deduction total overflow"))
            })?;
    let net_pay_won = input
        .monthly_remuneration_won
        .checked_sub(total_employee_deductions_won)
        .ok_or_else(|| KernelError::validation("deductions exceed gross wage"))?;

    Ok(PayrollDraft {
        pay_date: input.pay_date,
        gross_wage_won: input.monthly_remuneration_won,
        taxable_income_tax_table_version: tax_row.table_version,
        lines,
        total_employee_deductions_won,
        net_pay_won,
    })
}

pub fn build_severance_pay_draft(
    input: SeverancePayInput,
) -> Result<SeverancePayDraft, KernelError> {
    if input.exit_date < input.hire_date {
        return Err(KernelError::validation(
            "exit date must be on or after hire date",
        ));
    }
    if input.average_wage_period_end < input.average_wage_period_start {
        return Err(KernelError::validation(
            "average wage period end must be on or after start",
        ));
    }
    if input.average_wage_period_end > input.exit_date {
        return Err(KernelError::validation(
            "average wage period must not end after the exit date",
        ));
    }
    if input.average_wage_calendar_days <= 0 {
        return Err(KernelError::validation(
            "average wage calendar days must be positive",
        ));
    }
    if input.average_wage_total_won <= 0 {
        return Err(KernelError::validation(
            "average wage total must be positive",
        ));
    }

    let service_days = i64::from(
        input
            .exit_date
            .to_julian_day()
            .saturating_sub(input.hire_date.to_julian_day())
            + 1,
    );
    if service_days < 365 {
        return Err(KernelError::validation(
            "statutory severance pay requires at least one year of service",
        ));
    }

    let average_daily_wage_milliwon = checked_i128_to_i64(
        checked_mul_i128(input.average_wage_total_won, 1_000)?
            / i128::from(input.average_wage_calendar_days),
    )?;
    let statutory_30_day_wage_won = checked_i128_to_i64(
        checked_mul_i128(input.average_wage_total_won, 30)?
            / i128::from(input.average_wage_calendar_days),
    )?;
    let severance_pay_won = checked_i128_to_i64(
        checked_mul_i128(input.average_wage_total_won, 30)?
            .checked_mul(i128::from(service_days))
            .ok_or_else(|| KernelError::validation("severance calculation overflow"))?
            / i128::from(input.average_wage_calendar_days)
            / 365,
    )?;

    Ok(SeverancePayDraft {
        hire_date: input.hire_date,
        exit_date: input.exit_date,
        service_days,
        average_wage_period_start: input.average_wage_period_start,
        average_wage_period_end: input.average_wage_period_end,
        average_wage_calendar_days: input.average_wage_calendar_days,
        average_wage_total_won: input.average_wage_total_won,
        average_daily_wage_milliwon,
        statutory_30_day_wage_won,
        severance_pay_won,
        source: moel_retirement_pay_source(),
    })
}

pub fn validate_release_gate(input: &PayrollReleaseGateInput) -> Result<(), KernelError> {
    if input.rate_table_version.trim().is_empty() {
        return Err(KernelError::validation(
            "payroll rate table version is required",
        ));
    }
    if input.official_source_urls.is_empty() {
        return Err(KernelError::validation(
            "at least one official source URL is required",
        ));
    }
    if input.golden_cases.is_empty() {
        return Err(KernelError::validation(
            "at least one payroll golden case is required",
        ));
    }
    if let Some(case) = input
        .golden_cases
        .iter()
        .find(|case| case.rate_table_version != input.rate_table_version)
    {
        return Err(KernelError::validation(format!(
            "golden case {} uses mismatched rate table version",
            case.case_id
        )));
    }
    if let Some(case) = input
        .golden_cases
        .iter()
        .find(|case| !case.professionally_validated)
    {
        return Err(KernelError::validation(format!(
            "golden case {} lacks professional validation",
            case.case_id
        )));
    }
    let validation = input.professional_validation.as_ref().ok_or_else(|| {
        KernelError::validation("노무사/세무사 professional validation is required")
    })?;
    if validation.artifact_sha256.len() != 64
        || !validation
            .artifact_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(KernelError::validation(
            "professional validation artifact_sha256 must be a 64-character hex digest",
        ));
    }
    if validation.reviewer_reference.trim().is_empty() {
        return Err(KernelError::validation(
            "professional validation reviewer reference is required",
        ));
    }
    Ok(())
}

fn employee_amount(rate: ContributionRate, basis_won: i64) -> Result<i64, KernelError> {
    let ppm = rate.employee_ppm.ok_or_else(|| {
        KernelError::validation(format!(
            "payroll rate {:?} has no employee share",
            rate.code
        ))
    })?;
    amount_by_ppm_floor_won(basis_won, ppm)
}

fn amount_by_ppm_floor_won(base_won: i64, ppm: u32) -> Result<i64, KernelError> {
    if base_won < 0 {
        return Err(KernelError::validation("rate base must be non-negative"));
    }
    let amount = i128::from(base_won)
        .checked_mul(i128::from(ppm))
        .ok_or_else(|| KernelError::validation("payroll rate multiplication overflow"))?
        / PPM_DENOMINATOR;
    i64::try_from(amount).map_err(|_| KernelError::validation("payroll amount overflow"))
}

fn checked_mul_i128(left: i64, right: i64) -> Result<i128, KernelError> {
    i128::from(left)
        .checked_mul(i128::from(right))
        .ok_or_else(|| KernelError::validation("payroll amount multiplication overflow"))
}

fn checked_i128_to_i64(amount: i128) -> Result<i64, KernelError> {
    i64::try_from(amount).map_err(|_| KernelError::validation("payroll amount overflow"))
}

fn deduction(
    code: DeductionCode,
    label_ko: &'static str,
    amount_won: i64,
    source_url: &'static str,
) -> DeductionLine {
    DeductionLine {
        code,
        label_ko,
        amount_won,
        source_url,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_tax_row() -> NtsWithholdingTaxRow {
        NtsWithholdingTaxRow {
            table_version: "NTS-간이세액표-fixture-row-v1",
            monthly_income_tax_won: 74_350,
            local_income_tax_won: 7_430,
            source: nts_source(),
        }
    }

    #[test]
    fn selects_2026_rates_and_effective_dated_pension_limits() {
        let june_limit = national_pension_limit_on(date!(2026 - 06 - 27)).unwrap();
        assert_eq!(june_limit.minimum_won, 400_000);
        assert_eq!(june_limit.maximum_won, 6_370_000);

        let july_limit = national_pension_limit_on(date!(2026 - 07 - 01)).unwrap();
        assert_eq!(july_limit.minimum_won, 410_000);
        assert_eq!(july_limit.maximum_won, 6_590_000);

        let pension =
            contribution_rate_on(ContributionCode::NationalPension, date!(2026 - 06 - 27)).unwrap();
        assert_eq!(pension.employee_ppm, Some(47_500));
        assert_eq!(pension.employer_ppm, Some(47_500));

        let minimum_wage = minimum_wage_on(date!(2026 - 06 - 27)).unwrap();
        assert_eq!(minimum_wage.hourly_won, 10_320);
        assert_eq!(minimum_wage.monthly_209h_won, 2_156_880);
    }

    #[test]
    fn refuses_to_estimate_income_tax_without_an_nts_table_row() {
        let result = build_employee_payroll_draft(PayrollDraftInput {
            pay_date: date!(2026 - 06 - 27),
            monthly_remuneration_won: 3_000_000,
            pension_standard_monthly_income_won: None,
            nts_tax_row: None,
        });

        assert!(result.is_err());
        assert!(format!("{:?}", result.err().unwrap()).contains("NTS withholding tax table row"));
    }

    #[test]
    fn builds_employee_deduction_draft_from_effective_rates_and_supplied_nts_row() {
        let draft = build_employee_payroll_draft(PayrollDraftInput {
            pay_date: date!(2026 - 06 - 27),
            monthly_remuneration_won: 3_000_000,
            pension_standard_monthly_income_won: None,
            nts_tax_row: Some(fixture_tax_row()),
        })
        .unwrap();

        assert_eq!(line_amount(&draft, DeductionCode::NationalPension), 142_500);
        assert_eq!(line_amount(&draft, DeductionCode::HealthInsurance), 107_850);
        assert_eq!(line_amount(&draft, DeductionCode::LongTermCare), 14_172);
        assert_eq!(
            line_amount(&draft, DeductionCode::EmploymentInsurance),
            27_000
        );
        assert_eq!(line_amount(&draft, DeductionCode::IncomeTax), 74_350);
        assert_eq!(line_amount(&draft, DeductionCode::LocalIncomeTax), 7_430);
        assert_eq!(draft.total_employee_deductions_won, 373_302);
        assert_eq!(draft.net_pay_won, 2_626_698);
        assert_eq!(
            draft.taxable_income_tax_table_version,
            "NTS-간이세액표-fixture-row-v1"
        );
    }

    #[test]
    fn caps_national_pension_basis_by_effective_limit() {
        let draft = build_employee_payroll_draft(PayrollDraftInput {
            pay_date: date!(2026 - 07 - 01),
            monthly_remuneration_won: 10_000_000,
            pension_standard_monthly_income_won: None,
            nts_tax_row: Some(fixture_tax_row()),
        })
        .unwrap();

        assert_eq!(line_amount(&draft, DeductionCode::NationalPension), 313_025);
    }

    #[test]
    fn release_gate_requires_validated_golden_case_and_professional_artifact() {
        let unvalidated = PayrollReleaseGateInput {
            rate_table_version: "KR-2026-official-rates-v1".to_string(),
            official_source_urls: vec![nps_source().url.to_string(), nhis_source().url.to_string()],
            golden_cases: vec![GoldenPayrollCase {
                case_id: "golden-fixture-unvalidated".to_string(),
                rate_table_version: "KR-2026-official-rates-v1".to_string(),
                professionally_validated: false,
                expected_total_employee_deductions_won: 373_302,
            }],
            professional_validation: None,
        };
        assert!(validate_release_gate(&unvalidated).is_err());

        let validated = PayrollReleaseGateInput {
            rate_table_version: "KR-2026-official-rates-v1".to_string(),
            official_source_urls: vec![
                nps_source().url.to_string(),
                nhis_source().url.to_string(),
                nts_source().url.to_string(),
                minimum_wage_source().url.to_string(),
            ],
            golden_cases: vec![GoldenPayrollCase {
                case_id: "golden-fixture-professionally-reviewed".to_string(),
                rate_table_version: "KR-2026-official-rates-v1".to_string(),
                professionally_validated: true,
                expected_total_employee_deductions_won: 373_302,
            }],
            professional_validation: Some(ProfessionalValidation {
                reviewer_kind: ProfessionalReviewerKind::LaborAttorney,
                reviewed_on: date!(2026 - 06 - 27),
                artifact_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                    .to_string(),
                reviewer_reference: "licensed-reviewer-record".to_string(),
            }),
        };
        validate_release_gate(&validated).unwrap();
    }

    #[test]
    fn builds_severance_pay_from_moel_average_wage_formula() {
        let draft = build_severance_pay_draft(SeverancePayInput {
            hire_date: date!(2024 - 01 - 01),
            exit_date: date!(2026 - 06 - 30),
            average_wage_period_start: date!(2026 - 04 - 01),
            average_wage_period_end: date!(2026 - 06 - 30),
            average_wage_calendar_days: 91,
            average_wage_total_won: 9_100_000,
        })
        .unwrap();

        assert_eq!(draft.service_days, 912);
        assert_eq!(draft.average_daily_wage_milliwon, 100_000_000);
        assert_eq!(draft.statutory_30_day_wage_won, 3_000_000);
        assert_eq!(draft.severance_pay_won, 7_495_890);
        assert_eq!(draft.source, moel_retirement_pay_source());
    }

    #[test]
    fn severance_pay_refuses_short_service_or_missing_wage_basis() {
        let short_service = build_severance_pay_draft(SeverancePayInput {
            hire_date: date!(2026 - 01 - 01),
            exit_date: date!(2026 - 06 - 30),
            average_wage_period_start: date!(2026 - 04 - 01),
            average_wage_period_end: date!(2026 - 06 - 30),
            average_wage_calendar_days: 91,
            average_wage_total_won: 9_100_000,
        });
        assert!(short_service.is_err());

        let missing_wage = build_severance_pay_draft(SeverancePayInput {
            hire_date: date!(2024 - 01 - 01),
            exit_date: date!(2026 - 06 - 30),
            average_wage_period_start: date!(2026 - 04 - 01),
            average_wage_period_end: date!(2026 - 06 - 30),
            average_wage_calendar_days: 91,
            average_wage_total_won: 0,
        });
        assert!(missing_wage.is_err());
    }

    fn line_amount(draft: &PayrollDraft, code: DeductionCode) -> i64 {
        draft
            .lines
            .iter()
            .find(|line| line.code == code)
            .unwrap()
            .amount_won
    }
}
