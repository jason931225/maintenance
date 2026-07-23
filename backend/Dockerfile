# syntax=docker/dockerfile:1

# Base images pinned to their multi-arch index digest for reproducible builds;
# Renovate (docker:pinDigests) keeps the digest current behind the tag.
FROM rust:1.96-bookworm@sha256:19817ead3289c8c631c73df281e18b59b172f6a31f4f563290f69cddd06c30e9 AS builder

WORKDIR /workspace/backend

# Deterministic timestamps: BuildKit clamps image/layer mtimes to this epoch
# (passed by CI from the commit time). Harmless when unset for local builds.
ARG SOURCE_DATE_EPOCH
ENV SQLX_OFFLINE=true

# rust-toolchain.toml pins rustc 1.96.0; resolve it before the build.
COPY backend/rust-toolchain.toml ./rust-toolchain.toml

# Sources. The build context is the repo ROOT (see ops/compose.yml) so the
# golden Excel templates and Cedar/PBAC maps embedded by backend crates via
# include_bytes!("../../../../../docs/reference/…") / include_str!("...docs/specs/…")
# resolve under /workspace/docs at compile time. --locked keeps the build
# reproducible against the committed Cargo.lock.
COPY backend/Cargo.toml backend/Cargo.lock ./
COPY backend/.sqlx ./.sqlx
COPY backend/app ./app
COPY backend/ci ./ci
COPY backend/crates ./crates
COPY backend/openapi ./openapi
# [patch.crates-io] in Cargo.toml points calamine/quick-xml/umya-spreadsheet at
# the repository Rust third-party boundary (RUSTSEC-2026-0194/0195 unblock).
# Preserve that repo-relative layout so Cargo resolves the exact audited copy.
COPY third-party/rust/vendor /workspace/third-party/rust/vendor
COPY docs/reference /workspace/docs/reference
COPY docs/specs /workspace/docs/specs

RUN cargo build --locked --release -p mnt-app

FROM debian:bookworm-slim@sha256:96e378d7e6531ac9a15ad505478fcc2e69f371b10f5cdf87857c4b8188404716 AS runtime

# ffmpeg is REQUIRED by the worker role: the evidence media pipeline shells out
# to it to transcode mechanic video to 1080p H.264/AAC MP4 and to recompress /
# strip-metadata images BEFORE they are stored. All roles ship the same image
# (single binary, role selected by MNT_APP_ROLE), so ffmpeg is installed once
# here. Image-size impact: debian's `ffmpeg` pulls its codec/AV libraries and
# adds roughly ~250-300 MB to the previously ~80 MB slim runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin mnt

COPY --from=builder /workspace/backend/target/release/mnt-app /usr/local/bin/mnt-app

USER 10001
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/mnt-app"]
