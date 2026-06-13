# syntax=docker/dockerfile:1

FROM rust:1.96-bookworm AS builder

WORKDIR /workspace/backend

# Build context is the repo ROOT (see ops/compose.yml) so the golden Excel
# templates the reporting crate embeds via include_bytes!("../../../../../docs/
# reference/…") resolve to /workspace/docs/reference at compile time.
COPY backend/Cargo.toml backend/Cargo.lock backend/rust-toolchain.toml ./
COPY backend/.sqlx ./.sqlx
COPY backend/app ./app
COPY backend/ci ./ci
COPY backend/crates ./crates
COPY backend/openapi ./openapi
COPY docs/reference /workspace/docs/reference

ENV SQLX_OFFLINE=true

RUN cargo build --locked --release -p mnt-app

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin mnt

COPY --from=builder /workspace/backend/target/release/mnt-app /usr/local/bin/mnt-app

USER 10001
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/mnt-app"]
