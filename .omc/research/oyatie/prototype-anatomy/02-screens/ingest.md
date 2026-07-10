# Oyatie Console — Spec for 데이터 인제스트 / INGEST (screen id `"ingest"`)

File: `docs/design/oyatie-console/Oyatie Console.dc.html` (Jul-4 09:04 mirror).

## ⚠ Verification status — read first

**This screen has NO code in the repo snapshot.** The change log records `screen:"ingest"` started (AGENTS.md:38, entry 2026-07-04 (5)) and completed+verified (AGENTS.md:39, entry (6); ROADMAP.md:111) later on Jul 4, but the dc.html mirror was saved at 09:04, before those slices. Verified absences in the snapshot:

- `grep '"ingest"'` → 0 hits (no screen id, no state keys, no `ingest*` methods).
- `workflows` seed (dc.html 3844–3861) contains **wf1–wf4 only** — the wf5/wf6 external-API-ingest workflows do not exist yet.
- Nav sidebar (dc.html 6163–6205) has no 인제스트 item.
- All 17 worktree copies of dc.html are byte-identical; SYNC-MANIFEST.md:17 confirms the 698KB file exceeds the DesignSync read cap and was not re-fetched — for post-Jul-4 screens "the change log + DESIGN §4.7 grammar catalog are the spec" (SYNC-MANIFEST.md:29).

Everything below is therefore **UNVERIFIED against code** — reconstructed from AGENTS.md change-log entries, ROADMAP.md, and HANDOFF.md §10 (which IS the intended backend contract). Line cites go to those markdown files.

---

## 1. Screen contract (changelog-level)

### 1.1 Layout anatomy (AGENTS.md:38–39; ROADMAP.md:111)

- **Source strip**: connector sources — file upload (11 file types + 사진·영상·ZIP·임의 arbitrary files) + **external API connectors** (REST poll/webhook).
- **Queue**: ingest-job list with **filter · search · J/K keyboard navigation** (same J/K idiom as other list screens).
- **7-stage deterministic (no-AI) pipeline** per job — stage stepper: `uploaded → parse(파싱/OCR) → sanitize(정제) → classify(분류·템플릿) → map(매핑) → review(검증) → committed | failed` (stage enum from HANDOFF.md:63).
- **Provenance preview variants** by source kind: 스캔(OCR 영역 오버레이) · 표(table) · JSON(structured) · 미디어 · ZIP · 실패(failure) (AGENTS.md:39 "출처 프리뷰(스캔 OCR영역·표·JSON·미디어·ZIP·실패)").
- **Field-mapping review panel**: per-field rows with **confidence(신뢰도) · PII flag · 검증/수정(verify/edit)** actions; low-confidence fields require human review before commit.
- **Ontology commit(적재)**: commit creates a typed ontology object + provenance/lineage + back-references + audit event + classification.
- **DX- codes**: every ingest job is an `IngestJob` object with a `DX-` reference code.

### 1.2 Interactive affordances (method names from AGENTS.md:39)

Changelog names the logic surface as `ingest*`: **`advance / upload / connPoll / fieldEdit / verify / commit / autoToggle / JK`**. Inferred affordance map (UNVERIFIED):

| Affordance | Handler (named in changelog) | Effect |
|---|---|---|
| Stage advance | `ingestAdvance` | step job through the 7-stage pipeline; each transition = audit event |
| File upload tile | `ingestUpload` | create a new DX- job (post-Jul-4, this same method becomes the mail-attachment primary CTA — AGENTS.md:71 (11a)) |
| API connector poll | `ingestConnPoll` | pull from external API source (나라장터 demo) |
| Field row edit | `ingestFieldEdit` | correct a mapped value |
| Field verify | `ingestVerify` | accept a low-confidence mapping |
| 적재 (commit) | `ingestCommit` | ontology load + audit; verified demos: 계약서→**C-208**, 나라장터→**Bid-633** (AGENTS.md:39; ROADMAP.md:111) |
| Auto-commit toggle | `ingestAutoToggle` | auto-load above confidence threshold (HANDOFF.md:67 "임계 초과시 자동 적재") |
| J/K | queue keyboard nav | move selection |

### 1.3 Seed/backend data shapes (HANDOFF.md §10, lines 61–67 — the authoritative contract)

**Source (커넥터) = object** (HANDOFF.md:62):
```
{ id, kind: "file"|"api"|"db"|"sftp"|"queue", name, auth, cadence, status }
// auth·rate-limit·schema-drift·retry are backend concerns
```

**IngestJob `DX-`** (HANDOFF.md:63):
```
{ code: "DX-…", source, file|endpoint, mime,
  srcKind: "scan"|"native"|"table"|"structured"|"media"|"archive",   // drives preview variant
  docType, template,
  stage: "uploaded"|"parse"|"sanitize"|"classify"|"map"|"review"|"committed"|"failed",
  fields: [{ label, raw, val, conf, tgt, status, pii, provenance }],
  cls, target, hash, integrityChain }
// every stage transition = audit event
```

**Template (매핑 규칙) = object** (HANDOFF.md:65): no-code, reusable, versioned; field→ontology mapping + regex + validation + confidence thresholds.

**Provenance/Lineage** (HANDOFF.md:66): every value traces (source doc · region/cell/path · transform step) — Foundry Data Lineage benchmark.

**Pipeline implementation intent** (HANDOFF.md:64, Rust, deterministic): calamine(xlsx)·csv·quick-xml·serde_json·pdf-extract/lopdf·docx-rs·leptess/Tesseract(OCR)·EXIF·ffmpeg → sanitize (normalization, Great-Expectations-style validation, PII regex/dictionaries) → classify (structural signature + keyword rules → template match) → map (regex/anchors · header inference · gazetteer · fuzzy match · type coercion · confidence) → review (low-confidence = human) → commit. **No AI anywhere** — templates, rules, statistics only.

### 1.4 Workflows wf5/wf6 (external API ingest)

AGENTS.md:39 seeds **2 external-API-ingest workflows** ("워크플로 wf5·wf6(외부 API 인제스트)") plus data-pipeline action blocks (AGENTS.md:38 "씨드 워크플로 2개+데이터 파이프라인 액션"). The snapshot's `workflows` seed shape they extend is verified at dc.html 3844–3861: `{ id, name, active, runs, lastRun, lastResult, trigger:{label,icon}, when:[{label}], then:[{label,icon}] }`. HANDOFF.md:67: ingest is exposed as a workflow trigger ("새 인제스트 레코드"), scheduled polls, auto-commit above threshold.

### 1.5 Post-Jul-4 deltas touching this screen (also UNVERIFIED)

- **Lifecycle retrofit** (AGENTS.md:69, 2026-07-08 (10)): `lcSeed` derives from `ingestJobs` (confirming the runtime state key is **`ingestJobs`**); commit(적재) = lifecycle review entry; clicking a committed job opens the lifecycle card.
- **File-first sweep** (AGENTS.md:71, (11a)): `ingestUpload` becomes the primary CTA for mail attachments (real DX- creation); evidence registration prefills records registration.
- **Module surfaces** (AGENTS.md:55, (4)): 실사(stocktake) module primary action routes to ingest.

## 2. Cross-references

- Audit: every stage transition and commit emits `logEvent` (audit hash-chain), consistent with the verified audit-event grammar at dc.html 3874+.
- Ontology: committed objects join the explore graph (see `explore.md`); ingest→계약 is one of the seeded graph chains (ROADMAP.md:110).
- To verify this spec against real code: export a current copy of the prototype from the claude.ai design project (`SYNC-MANIFEST.md:18` — manual save/export required; DesignSync cannot read the 698KB file).
