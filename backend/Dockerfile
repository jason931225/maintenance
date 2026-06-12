# syntax=docker/dockerfile:1

FROM rust:1.96-bookworm AS builder

WORKDIR /workspace/backend

COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY .sqlx ./.sqlx
COPY app ./app
COPY ci ./ci
COPY crates ./crates

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
