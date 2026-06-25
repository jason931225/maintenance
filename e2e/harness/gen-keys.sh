#!/usr/bin/env bash
# Generate an ES256 (P-256) JWT keypair for the e2e backend and export the PEMs.
#
# Idempotent: keys are written once under e2e/.auth/ and reused on subsequent
# runs so a passkey enrolled against one boot still verifies on the next. Source
# this script (`. gen-keys.sh`) to get MNT_JWT_PRIVATE_KEY_PEM / _PUBLIC_KEY_PEM
# exported into the current shell; running it directly just (re)creates the files.
set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUTH_DIR="${E2E_DIR}/.auth"
PRIV="${AUTH_DIR}/jwt-es256-private.pem"
PUB="${AUTH_DIR}/jwt-es256-public.pem"

mkdir -p "${AUTH_DIR}"

if [[ ! -s "${PRIV}" || ! -s "${PUB}" ]]; then
  # PKCS#8 P-256 private key + matching SPKI public key. The backend's jwt
  # verifier loads a SPKI/PKCS#8 PEM (ES256).
  openssl ecparam -name prime256v1 -genkey -noout 2>/dev/null \
    | openssl pkcs8 -topk8 -nocrypt -out "${PRIV}"
  openssl ec -in "${PRIV}" -pubout -out "${PUB}" 2>/dev/null
  echo "gen-keys: created ES256 keypair under ${AUTH_DIR}" >&2
else
  echo "gen-keys: reusing existing ES256 keypair under ${AUTH_DIR}" >&2
fi

MNT_JWT_PRIVATE_KEY_PEM="$(cat "${PRIV}")"
MNT_JWT_PUBLIC_KEY_PEM="$(cat "${PUB}")"
export MNT_JWT_PRIVATE_KEY_PEM MNT_JWT_PUBLIC_KEY_PEM
