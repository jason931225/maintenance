# PF-REF3 stored-byte receipt

**Task:** `t_50c98255`  
**Receipt time:** 2026-07-19T18:54:00Z  
**Purpose:** bind the repaired evidence packet to the exact bytes stored by Hermes before fresh independent review.  This is a custody receipt, not an approval or product-parity claim.

## Input custody recheck

PF-REF1 attachments `1180`–`1183` and PF-REF2 attachments `1210`–`1212` were SHA-256 rechecked against their recorded values in the PF-REF3 manifest.  The canonical lifecycle file was read-only rechecked at SHA-256 `25778cd94a64062e3976673bab91c93f252840faef0f6f9280374eb8aad846cf`.

## Post-upload stored-byte verification

| Hermes attachment | Artifact | Local SHA-256 | Stored SHA-256 | Result |
|---:|---|---|---|---|
| 1221 | `PF-REF3-palantir-official-source-ledger-2026-07-19.json` | `c01e9dbdb4be63574775ab2d2b79819cdea57c87aba70ac9423527f99bf820c4` | `c01e9dbdb4be63574775ab2d2b79819cdea57c87aba70ac9423527f99bf820c4` | PASS |
| 1222 | `PF-REF3-palantir-official-capability-matrix-2026-07-19.md` | `db7b6d9888b79a5477c0279bf9c31436cc7077b9ffabbe03ed2b34cb2fde7fb3` | `db7b6d9888b79a5477c0279bf9c31436cc7077b9ffabbe03ed2b34cb2fde7fb3` | PASS |
| 1223 | `PF-REF3-palantir-official-synthesis-route249-handoff-2026-07-19.md` | `a839623bcc8dd617667d8d75610fbfd647df6cf1842de32a9cb02ef7126f835e` | `a839623bcc8dd617667d8d75610fbfd647df6cf1842de32a9cb02ef7126f835e` | PASS |
| 1224 | `PF-REF3-palantir-official-repair-manifest-2026-07-19.json` | `978c4d7ee0b5a01bb870da0975acc8aa40384521f01c656a7031cac107c910d2` | `978c4d7ee0b5a01bb870da0975acc8aa40384521f01c656a7031cac107c910d2` | PASS |

## Evidence checks

- 31/31 direct `www.palantir.com/docs/foundry` URLs were live reopened at the per-source UTC time in the ledger and returned HTTP 200.
- 31/31 entries carry canonical URL, `retrieved_at`, `source_date_status`, current-availability qualification, and direct section-to-claim mapping.
- P22 controls the formerly unledgered Functions getting-started URL.
- P23–P31 establish the requested Builds, Pipeline Builder/transforms, Workflow Lineage, policy/versioning, and operational-observability coverage.
- P09 and P12 have distinct migration caveats. The matrix retains Korea residency/retention/legal hold/DSR, PostgreSQL RLS, fresh-fence/idempotency, and tamper-evident audit as explicit beyond-parity console requirements.

## Algorithmic routing receipt

| Field | Recorded value |
|---|---|
| Role | `researcher` |
| Model family | `GPT-5.6` |
| Exact model | `gpt-5.6-terra` |
| GPT-5.5 use | `none` |
| Decision mode | hard gates enabled; a failed hard gate overrides utility |
| Utility | `U=0.72Q+0.13E+0.15T` |
| Bias | quality is the highest-weight term |

## Terminal boundary

All PF-REF3 artifact-production gates passed. The only intentionally open gate is independent fresh review. Requested Hermes terminal state: `OFFICIAL_PARITY_REFERENCE_REPAIR_COMPLETE_PENDING_FRESH_REVIEW`.

**Held claims:** no document in this packet asserts Palantir-declared exactly-once/idempotency, deterministic conflicts, cross-tenant security, cross-resource/external-effect atomicity, tamper-evident audit, Korea residency, legal-hold precedence, DSR, PostgreSQL RLS, RPO/RTO, availability SLO, or guaranteed log/notification delivery.
