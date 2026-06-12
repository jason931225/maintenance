//! Reporting application layer.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::future::Future;

use mnt_kernel_core::{BranchScope, KernelError};
pub use mnt_reporting_domain::{
    KpiMetric, KpiReport, KpiRollup, KpiRollupScope, KpiScope, Period, UnavailableMetric,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KpiQuery {
    pub period: Period,
    pub scope: KpiScope,
    pub branch_scope: BranchScope,
}

#[derive(Debug, thiserror::Error)]
pub enum KpiQueryError {
    #[error(transparent)]
    Kernel(#[from] KernelError),

    #[error("database error: {0}")]
    Database(String),
}

pub trait KpiQueryPort {
    fn query_kpis(
        &self,
        query: KpiQuery,
    ) -> impl Future<Output = Result<KpiReport, KpiQueryError>> + Send + '_;
}
