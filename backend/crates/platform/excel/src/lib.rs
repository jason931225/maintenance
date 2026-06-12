//! Excel platform adapter.
//!
//! Provides byte-fidelity template filling for the Korean daily-status (일일업무진행현황)
//! Excel form using umya-spreadsheet.
//!
//! This crate exists primarily as the result of the T0.10 viability spike (ADR-0008).
//! Production fill logic will live here once the spike is promoted.

/// Re-export the underlying spreadsheet engine so callers need not add it as a
/// direct dependency.
pub use umya_spreadsheet;
