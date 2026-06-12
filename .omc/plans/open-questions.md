# Open Questions

## fsm-maintenance-plan — 2026-06-11
- [ ] Rental quote formula specifics (정액/정률, 내용연수, 잔존율, 관리비율, 이윤율 defaults) — validate with 경리/손화나 using real 예비차량 sheet data; negative 잔존가 occurs in real data, confirm handling rule. — Affects rental-quote acceptance criterion (T5.2) and 잔존가 recompute (T5.3).
- [ ] Purchase approval actor chain + thresholds — confirm 정비사 발주기록 → 접수자/경리 구매요청서 → 관리자 승인 → 지출결의서 → 임원(전무) 최종승인 above threshold; threshold values configurable. — Affects purchase workflow (T5.4).
- [ ] P1 escalation timer defaults (accept-window 5min / force-assign alert 10min / Alimtalk no-ack 2min) — confirm with operations before go-live. — Affects dispatch escalation (T2.4/T2.5).
- [ ] a2 (APNs) crate maintenance risk — last published 2024-05; confirm acceptable or select alternative at M1 cargo-add time. — Affects native push (T1.6) and ADR-0011-adjacent push decision.
- [ ] FCM HTTP v1 client crate choice — verify current/maintained crate at M1 `cargo add` time (versions never from training data). — Affects Android push (T1.6).
- [ ] RustFS GA re-evaluation (~2026-07) — schedule a post-launch decision point to re-assess RustFS vs SeaweedFS. — Affects storage ADR-0005 follow-up.
- [ ] KCC LBS 사업 신고 — business/legal action; confirm filing owner and lead time before go-live (launch-blocking). — Affects compliance gate (T2.3, T6.5).
