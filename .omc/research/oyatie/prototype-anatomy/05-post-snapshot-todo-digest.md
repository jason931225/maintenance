# Post-snapshot feature digest (from TODO.md, for screens/behaviors added after the Jul-4 dc.html snapshot)

> Source: docs/design/oyatie-console/TODO.md (195 lines) + CLAUDE.md charter. Status markers follow the file: `[x]` done, `[~]` partial, `[ ]` planned. These specs complement the snapshot-derived screen specs — anything marked here but absent from the Jul-4 snapshot must be built from this text + AGENTS.md change log (UNVERIFIED-AGAINST-SNAPSHOT).

## Charter facts (load-bearing)
- Everything is an Object: people/orgs/docs/contracts AND actions/events/phenomena. Ontology 3 layers = meaning · behavior · dynamics on one object.
- Object chain: 계약(C-) → position → posting → applicant → employee → timetable/attendance → overtime → payroll → analysis → profitability feedback.
- Lifecycle: 초안→상신·검토→승인·게시(민감=passkey)→활성→개정(v+1)→보관→폐기. Every transition = audit + version + rollback + PBAC + chip/stepper.
- Console-wide Cedar PBAC; "전체" = union of authorized entities; reads logged; secret zones deny-by-omission.
- Hard bans: explanatory captions/subtitles/protocol captions, non-functional text/data, AI-slop visuals (gradients/emoji/rounded+left-border/Inter-Roboto-Arial), big-number KPI cards (→ compact 1-row stat bar), filler.
- Benchmarks: HR-suite=Workday/Monday · msgr=Slack · mail=Gmail · recruit=Greenhouse · audit=CloudTrail/Splunk · automation=Workato/ServiceNow · schedules=Airflow/Temporal · explore/policy/workflow=Palantir Foundry.

## dashboard [x] (+scope×period, insights)
- v1: stat bar 6 (인건비율·마진·출근율·결원·주52h·SLA) + contract profitability table + 6M labor-cost trend (current vs projected) + site coverage + 내 지표 (self scope). Invariant: EVERY number drills to a source object.
- Scope×period [x]: PBAC scope segment (전체=인가 합집합·코스·KNL·본사) × period (7월 진행/6월 확정 as-of) → recomputes 6 stats + profitability (KNL adds C-311; 본사=empty state).
- Insights = 5 AN- derived objects: 마진 침식·결원 재발·재협상 여지·교체 손익·최저임금 영향 — evidence-chain chips (real objects) + prescriptive actions (draft/card/explore) + graph merge.
- Planned: real-data derivation, scope selector, period selector, labor-cost analysis screen, forecasting.

## dispatch [x]
- WO- orders × candidate drivers × SLA; wired to dispatch/processing panel.
- SLA kanban: generic module field `lanes`, 3 columns (SLA 임박·예정·배정), cards link to row selection.
- Rows have "지도에서 보기" (mapOv/mapSel presets) ↔ map WO markers open dispatch panel.

## mywork [x]
- Aggregates live state: approvals awaiting me, dispatch queue, in-progress submissions, receipt-confirmations. Nav "개인" group.
- Notification rows resolve codes → 건명·요청자·마감·structured evidence kv + 「처리 팬널」 direct + object-card link. 4 stats drill.
- Per-persona recompute: 관리자=결재함 view; 반장=own submissions+dispatch; 사무직=own submissions ("내 상신 — 결재 진행" label).
- Planned: calendar to-do rows.

## map (운영 지도) [x]
- Template: stat bar (현장·미배정·SLA·커버리지, drill) · overlay segments (커버리지/이슈/계약/정비·배차) · grid canvas × site markers (value chips, danger pulse, selection ring) · unit layer (FL- forklifts·기사·BUS on WO overlay, click=object) · queue panel per overlay (dispatch queue SLA-sorted with processing CTA; issues; contracts; coverage; row=map highlight).
- Authoring: 「편집」 toggle — marker drag (`mapPos`, audited), "+ 현장" proposal (draft dashed, confirmed via reorg approval), canvas right-click add. Right-click quick-action menu (summary/object/attendance/dispatch-overlay/issue-draft/[draft]reorg — Esc/outside closes). Marker click = summary select + site summary card in queue panel (coverage·issues·contracts·maintenance tone values).
- Post-snapshot: Korea schematic terrain (coastline path + Jeju + DMZ dashed, token colors only). Residual: real coordinates (backend), driver realtime location.

## mail — Gmail benchmark
- Gmail threading [x] 2026-07-09: subject normalization (strip RE/FW/회신/전달) groups conversations; list rows get conversation-count chip (excl. trash/spam); read pane top = collapsed prior-message rows (보냄/받음 chips, click=expand).
- Egress gate [x]: 「개체 첨부」 (egressDocs registry, lifecycle chips) + external recipient × {draft·in-approval·sensitive} = send BLOCKED (blocker panel, single CTA 「결재 진행 보기」, disabled button); block attempt = anomaly audit + compliance alert; approved/published+대외비 = DLP warning only.
- Attachments: 「구조화 · 인제스트」 primary CTA (real DX-) + 「증거 등재」 prefill.
- Mobile 2-pane [x]: folder chip strip, list↔read, header back.
- Planned: mox backend integration (webapi/webhooks + IMAP4/SMTP), mox mods (audit hooks, Cedar PBAC, retention/litigation-hold/journaling/e-discovery, DLP, ontology Mail=CommObject).

## msgr — Slack/Teams benchmark [x]
- Sidebar channels(#)/direct + presence dots + search; message grouping + 「새 메시지」 divider; hover actions: 확인 ack (count chip, toggle) · 답장 quote (in-bubble quote block) · 할 일 (today link); header member chips + auto-extracted object-code chips (→objectLinkGo); composer autocomplete (@person + code prefix, arrows/Enter/Tab); meetings = MT- objects; @mention = notification contract; scroll landing (`_msgrScrollSync` scrollTop arithmetic — entry=divider/bottom, send=bottom).
- Slack thread mute [x] 2026-07-09: chat-header bell toggle (personal setting, §3.9.0 whitelist ①) → muted = bell-off icon, badge suppressed, excluded from mobile tab total.
- Residual: object-card sharing UI (instead of files).

## notif [x]
- Full-view rows = notifClick (same as rail): item/thread/screen routing + body-code fallback objectLinkGo.

## leave/benefit/appr — see 02-screens/appr-leave-benefit.md (full snapshot-verified spec).

## docs + evidence [x core]
- Record archive (AP-/공지/JL-/C-/IN-), type filter/search, retention. Registration: file drop + title/type/retention/reason → IN- pending → records-manager approval (docRegOpen/docRegSubmit).
- Evidence EV- [x] 2026-07-09: EVIDENCE() EV-101~103 (CCTV clip·소명 녹취·조사 ZIP) — 「증거」 filter; object card = SHA-256+TSA · WORM original vs derivative labels · chain-of-custody stage · eligibility chip (적격/검토/사본 + legal hold) · custody history · linked chips. UI contract done; transcoding/TSA/WORM = backend.
- Planned: WORM enforcement, RFC-3161 TSA, in-console viewer/player (photo/video, ZIP readonly tree, zip-bomb defense), ingest pipeline for media.

## policy (Cedar) [x]
- Natural-language rules (allow/deny · enforced/draft), who→what→action blocks, simulation, rule edit.
- No-code canvas [x]: block dropdowns + allow/deny segment + condition toggles (관리기기·업무시간·감사·passkey) + auto-generated rule text + "누가 무엇을 보는가" sim (principal sample) + draft save (lifecycle v+1, audit).
- Planned [~]: device/geo/network/time context rules, current-context card, device/network/timezone object types.

## ingest [x]
- Source strip (file drop + API connectors) + queue (filter/search/JK; 단계/유형/신뢰도/분류) + detail (7-stage pipeline; source preview variants scan-OCR/table/JSON/media/ZIP/failure; field-mapping review confidence/PII/verify; target object; ontology load). DX- codes.
- Pipeline: 수집→파싱/OCR→정제→분류·템플릿(no-AI)→매핑(결정적+신뢰도)→검증(human-in-the-loop)→적재(typed object·역참조·감사·provenance). 11 file types + photo/video/ZIP + API/webhook.
- Planned: no-code mapping template editor, schema-mapping canvas, lineage graph, real Rust parsers.

## explore [x]
- Object search (name/code/type → re-center). Graph authoring: "+ 새 개체" (type select → OB- draft + card, userNodes overlay) · "시리즈 승격" (seriesCreate → SR-21x + seriesAttach fold-in, trend recompute) · relations via drop zone (onExploreDrop) + node drag source (reference-token payload). Dynamics panel: rules touching center type → rule select.

## 10 module surfaces [x first pass] — codes: finance VC-(+FC-), purchase PO-, inventory IV-, asset FL-, maintenance WO-, field ST-, compliance CP-+RG-+FW-, laborcost(경영 분석), board NT-, directory
- All rows = typed graph nodes (_ogBuild merge; kv/link codes = auto edges). Object card 3 layers (attribute kv · lifecycle · dynamics chips). Relation drawing (code input, drag-drop = objLinks edge, audited). Governance CRUD (create=draft prefill · edit=v+1 · delete=archive/dispose gate).
- Generic module template fields: `stock` (inventory qty bar matrix: current bar + safety tick + monthly consumption, shortage=danger), `tl` (asset lifecycle timeline: acquire→maintenance events→return/replace dashed; WO-/AN-/SR- rows drill), `lanes` (SLA kanban), `prog` (board receipt progress bar done/total, 100%=ok else warn), `ctl` (Vanta control→evidence matrix: control ID·name·evidence=console feature·status chip 자동 수집/백엔드 대기; row=drill).
- compliance: dual CP- obligations + RG- regulations (RG-101 최저임금 2027: impact 12명·+₩2.4M/월·margin sim·adjustment-draft prefill·effective-date schedule; RG-102 주52h → FC-03). FW-01~04 standards (control → console-real-feature-as-evidence: hash chain·Cedar·staging·passkey·egress).
- laborcost → renamed 경영 분석: contract labor cost + site profitability (ST-) + utilization (UT-); rows = evidence objects, AN-/FC- chains.
- Clients CL-01~04 [x]: grade/terms/main-site attrs, trade-chain edges VC-/C-/CP-/WO-/IN-/SR- + site nodes; OT-12 active. Residual: revenue/receivable series, directory client tab.

## Series + type registry
- OBJ_SERIES 6: 임대료 SR-201(C-114)·서버비 SR-202·FL-2643 정비 SR-203·특수검진 SR-204·급여 회차 SR-205·대근비 SR-206. Fields: rule(주기), instance bar timeline, current/planned(dashed), trend.
- ontTypes 13 OT- types = lifecycle objects (11 active + draft 거래처 + archived 배차=WO- merged). Graph legend chips = type card entry (owner·version·active count·definition); "+ 타입 제안" inline → draft+card → review (data governance·exec SoD) → active. Archive gate = instance migration + automation/policy rebinding. lcSyncRegistries syncs.
- Planned: edge-type registry, per-type attribute schema editing, type card → instance drill, as-of reconstruction, series value input, OB- attribute editing.

## view-as personas [x]
- Sidebar role-switch card (user·role·clearance chip); 5 personas: 운영 관리자·HR 김성아·현장 반장 이종호·사무직 박지훈·CEO 정만호. Switch = audit event + nav deny-by-omission filter (사무직: no payroll/audit/policy/HR — self-service only) + logEvent actor=viewer. Palette results viewer-filtered; 내 업무 recomputed.
- Residual: data scope (payroll rows, dashboard aggregates), rail persona reflection, own-object highlight. Planned: persona workflow audit (7 roles, 3-click reach).

## Guardrails §3.10 [x reference]
- 6 layers: ① authz/qualification gate ② self-checklist ③ peer review (four-eyes, no self-review) ④ approval (SoD) ⑤ deploy/egress gate ⑥ detection. fail-closed.
- Contract-draft guardrail: 「계약 기안」 template (preflight audit) + submission panel: 4-item self-checklist attestation (timestamped) → four-eyes reviewer (excl. drafter) → SoD line auto-join; incomplete = blocked.
- Planned: retro to doc export/print, automation actions, ingest load, benefit/recruit; override flow (reason + higher approval).

## Automation `auto` [x]
- 2-tab master-detail (workflows + schedules). wfToggle/wfRun (real AP- creation)/wfSimulate/schToggle/schRun/schEdit. Trigger→condition→action visual flow. No-code block canvas (blocks = ontology types, auto rule name, sim, save=active+audit, fail-closed). runLog [x]: execution timeline (result dot·duration·created-object chip drill·error 「재시도」=audited), prepends. pendingRev staging: active-object edit → 「개정 대기 v+1 · 현행 유지」 banner → 「적용 승인」(four-eyes)=effectuate / 「철회」. External-API ingest workflows wf5 나라장터/wf6 오픈뱅킹.
- Schedule CRUD: new draft→cron edit→activate=publish; revise v+1; archive. Workflow CRUD: edit=canvas load→save v+1; archive.

## inbox [x]
- 2-pane vault: payslips (frictionless) + legal receipt-confirmation docs (근로계약·취업규칙·연차촉진·노무수령거부). Filters: 확인필요/급여명세/완료/전체. Read panel: lock gate / payroll breakdown / body / receipt stamp / linked objects. Nav badge = unconfirmed legal docs.
- Passkey gate: pkStart→pkAuth(scan anim)→inboxConfirm; `legal && !confirmed`=locked; auth=identity=receipt evidence → confirmed{by,at} stamp + audit. Touch-ID-style modal.

## audit [x]
- logEvent backbone: who/what/when/where/how/on-what/decision/integrity + classification (민감정보·대외비·비밀) + deviceCtx (device/browser/location/auth) + Cedar decision drives logging + trace ID + seq hash chain. Live append-only feed (day groups, newest top), filters (all/approval·workflow/read/policy-deny/anomaly/policy), full-text search, correlation drill, extended detail (Cedar deny reason, before→after), anomaly chips, export. covert=deny-by-omission. Nav badge = deny+anomaly. Standards: NIST 800-53 AU·ISO 27001·CADF/OCSF.
- Residual: per-object 활동 이력 tab, time-range selector, real tamper-evident signature (backend — SHIPPED as audit-chain).

## office shell [x 1st] (Euro-Office = ONLYOFFICE AGPL heavy fork; alternatives Collabora/Univer/Stirling-PDF)
- officeOpen/officeSave + editor modal (seed C-209 DOCX): contentEditable canvas (dirty chip, session audit), right governance rail (version list — callback save = immutable new version, compare/restore non-destructive + Cedar PBAC permission matrix), header collaborator avatars + DLP chip (print/export blocked), save=v+1 + audit. Entry = object card 「문서 편집」 chip.
- Planned: iframe editor API/JWT/callback embed, governance wrapper, heavy-mode internal integration (covert server-side render block, per-edit audit hooks), object↔session↔version↔AP-↔audit↔evidence links.

## Mobile [x]
- <768 = employee app, 7 screens ONLY: 메신저·메일·알림·주소록·게시판·수신함·전자결재. Bottom tab bar (메신저·메일·알림·결재·더보기; unread badges; 48px; safe-area). 더보기 = mobile sheet (수신함 badge·주소록·게시판; backdrop; Esc). Disallowed screens redirect to messenger (mount+resize guard). Separate artifact Oyatie Mobile.dc.html (iOS frame + 390px iframe).
- Residual: swipe gestures, composer keyboard-safe, 2-pane→single-pane cleanup.

## Remaining planned epics (backend-heavy)
- Jurisdiction/PII compliance suite (multi-jurisdiction objects, consent ledger, DSR self-service, cross-border gates, access-grant tokens = objects with TTL/single-use/break-glass).
- National-support/procurement/contract module (지원금·입찰·C- lifecycle).
- DLP/screen protection (honest threat model: suppress+track+gate; full prevention = enterprise browser/VDI layer only — no security theater).
- Benchmark-gap residuals: as-of reconstruction, type attribute schema editing, Asana done-toggle.

## Prompt-mismatch notes
- "map terrain": grid canvas + markers; Korea schematic terrain added post-snapshot (change log 35). No other terrain concept.
- `runLog` is a WORKFLOW/automation field (n8n benchmark), not dispatch. Dispatch has `lanes`.
- TONE helper: single tone helper `TONE(t)` (§4-18, change log 35) unifying ok/warn/danger value states; TODO.md shows only the usage, AGENTS (35) names the helper.
