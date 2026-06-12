//! `mnt-platform-db` — Postgres schema migrations and the `with_audit`
//! transactional helper.
//!
//! # Layering
//! This crate sits in the `platform` layer and is allowed to depend on
//! `mnt-kernel-core` (pure types) and `sqlx`. Domain and application crates
//! depend on this crate for the `with_audit` building block.
//!
//! # Append-only invariant
//! `audit_events` is structurally append-only: migration 0003 REVOKEs
//! UPDATE/DELETE from PUBLIC and installs BEFORE triggers that raise an
//! exception on any such attempt, even from privileged roles.
//!
//! # Offline query cache
//! Compile-time `query!` macros require either a live DATABASE_URL or a
//! committed `.sqlx/` offline cache. After schema changes run:
//!
//! ```sh
//! DATABASE_URL=postgres://localhost/mnt_dev \
//!     cargo sqlx prepare --workspace
//! ```
//!
//! then commit the regenerated `.sqlx/` directory. CI must set
//! `SQLX_OFFLINE=true`; missing cache entries fail the build explicitly.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

pub mod audit_tx;
pub mod error;

pub use audit_tx::with_audit;
pub use error::DbError;
