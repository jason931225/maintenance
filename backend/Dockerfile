# syntax=docker/dockerfile:1

# Base images pinned to their multi-arch index digest for reproducible builds;
# Renovate (docker:pinDigests) keeps the digest current behind the tag.
FROM rust:1.96-bookworm@sha256:19817ead3289c8c631c73df281e18b59b172f6a31f4f563290f69cddd06c30e9 AS chef

WORKDIR /workspace/backend

# Pin the toolchain in this shared base so every downstream stage agrees on
# rustc. cargo-chef's cached dependency build (cook) and the final app build
# MUST use the same toolchain, or the cache silently invalidates;
# rust-toolchain.toml selects 1.96.0 and is resolved once here.
COPY backend/rust-toolchain.toml ./rust-toolchain.toml

# cargo-chef turns the dependency graph into its own cacheable layer, so routine
# source edits stop triggering a from-scratch recompile of every crates.io
# crate (the reason these Rust image builds were slow). Version verified live
# against the crates.io index; --locked keeps the install reproducible.
RUN cargo install cargo-chef --version 0.1.77 --locked

FROM chef AS planner

# `prepare` reads the workspace manifests (every member's Cargo.toml) and emits a
# recipe describing the dependency graph. It compiles nothing, so it only needs
# the sources, not .sqlx or docs/reference.
COPY backend/Cargo.toml backend/Cargo.lock ./
COPY backend/app ./app
COPY backend/ci ./ci
COPY backend/crates ./crates
COPY backend/openapi ./openapi
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder

# Deterministic timestamps: BuildKit clamps image/layer mtimes to this epoch
# (passed by CI from the commit time). Harmless when unset for local builds.
ARG SOURCE_DATE_EPOCH
ENV SQLX_OFFLINE=true

# Build and cache ONLY the dependency graph from the recipe. This layer is reused
# across builds as long as Cargo.lock (and thus the recipe) is unchanged,
# regardless of first-party source edits. The recipe fully describes the
# manifests + lockfile, so no Cargo.toml copy is needed yet.
COPY --from=planner /workspace/backend/recipe.json ./recipe.json
RUN cargo chef cook --locked --release --recipe-path recipe.json

# Now the real sources. The build context is the repo ROOT (see ops/compose.yml)
# so the golden Excel templates the reporting crate embeds via
# include_bytes!("../../../../../docs/reference/…") resolve to
# /workspace/docs/reference at compile time.
COPY backend/Cargo.toml backend/Cargo.lock ./
COPY backend/.sqlx ./.sqlx
COPY backend/app ./app
COPY backend/ci ./ci
COPY backend/crates ./crates
COPY backend/openapi ./openapi
COPY docs/reference /workspace/docs/reference

RUN cargo build --locked --release -p mnt-app

FROM debian:bookworm-slim@sha256:96e378d7e6531ac9a15ad505478fcc2e69f371b10f5cdf87857c4b8188404716 AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin mnt

COPY --from=builder /workspace/backend/target/release/mnt-app /usr/local/bin/mnt-app

USER 10001
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/mnt-app"]
