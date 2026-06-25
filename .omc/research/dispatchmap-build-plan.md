All claims verified against real code. The designs are accurate. I have everything needed to produce the merged spec.

# 배차 지도 LIVE — Merged Build Plan (Task #29)

Verified against live code: `record_location_ping` (compliance/adapter-postgres:251, double-gate intact), consent-withdrawal DELETE block (:211–233), `RealtimeEvent` enum is `MessagePosted`-only (realtime:173), `RealtimePrincipal{user_id,branch_scope,org_id}` (:226), `dispatch_event` branch-scope fan-out (:587), dispatch on-duty proxy = "recent on_duty ping exists" (dispatch/adapter-postgres:1074–1094), and the 0042 latest+transient two-table RLS+FORCE+immutable-trigger pattern. The two received designs are internally consistent; the UX doc was missing but its content is fully covered by the PROVIDER doc's §1–7. Below is the reconciled, decided spec.

---

## (1) RECONCILED DECISIONS (conflicts resolved)

- **On-duty mechanism → server-owned `user_duty_status` (REALTIME §2), not the client boolean.** PROVIDER's `mayCollectGps(GRANTED ∧ onDuty)` stays as the *client* gate, but the *authority* is the server: `record_location_ping` adds a `user_duty_status.on_duty = true` check next to the existing consent `FOR SHARE`. Client `on_duty:true` becomes necessary-but-not-sufficient. The dispatch fan-out proxy (dispatch:1084–1092) switches from "recent on_duty ping EXISTS" to `JOIN user_duty_status ... WHERE on_duty` (recent-ping recency retained only for position freshness). Fail-closed: missing duty row = off.
- **WS message shape → REALTIME's `mechanic_position_updated` (tagged, snake_case), NOT PROVIDER's `MechanicLocation`.** One variant `RealtimeEvent::MechanicPositionUpdated { position: MechanicPosition }`; `MechanicPosition { user_id, user_name, branch_id, latitude, longitude, accuracy_m, heading_deg, speed_mps, recorded_at }`. NOTIFY payload carries IDs+org only (`PositionNotifyPayload { user_id, branch_id, org_id }`); the listener re-reads `mechanic_live_positions` under armed RLS (the messenger invariant). `branch_id()` returns the position branch so existing `branch_scope.allows()` works unchanged; thread-membership step is skipped for this variant.
- **Subscription model → one socket, opt-in selector `?subscribe=positions`** (REALTIME §3). Messenger connections do not receive positions; DispatchMap connections do. `ConnectionSlot` records the subscription set; `dispatch_event` skips unsubscribed connections.
- **Replay → snapshot, not cursor** (positions are last-write-wins). On connect with `subscribe=positions`, hub does ONE armed read of `mechanic_live_positions` in branch scope (`on_duty=true`, `recorded_at` within 10 min) and bursts them as `mechanic_position_updated`, then goes live.
- **Routing proxy endpoint → `POST /api/v1/dispatch/route` (server-side proxy), NOT a browser→OSRM call.** Body `{ from:{lat,lon}, to:{lat,lon} }`, response `{ coordinates:[[lat,lon]...], distance_m, duration_s }`. Rationale: (a) keeps any future provider key server-side (HARD REQ — no key in browser bundle), (b) OpsDashboardRead-gated, (c) lets us swap OSRM→Kakao→Google behind a Rust `RoutingProvider` trait without touching the web client. The web `RoutingProvider` abstraction still exists but its only impl calls our proxy.
- **Snapshot fallback → `GET /api/v1/dispatch/live-positions`** (same branch-scoped, OpsDashboardRead-gated read) for initial paint / WS-down degradation. `useLiveMechanics` degrades to polling this.
- **Keyless-now provider → Leaflet/OSM tiles (unchanged) + OSRM via the server proxy.** Kakao Mobility = recommended config-swap (single `RoutingProvider` impl + `MapProvider` tile swap, one env-keyed key in backend). Google = stub impl for when KR driving directions land. Selection: backend env `MNT_ROUTING_PROVIDER=osrm|kakao|google` (+ `MNT_KAKAO_REST_KEY` etc.); web tile selection `VITE_MAP_PROVIDER=osm|kakao`.
- **Dispatcher-only live layer** (PROVIDER §6): page stays gated to `OPERATIONAL_ROLES`; the live-mechanics layer + AssignmentList sub-gated to non-MECHANIC (`hasAnyRole([ADMIN,EXECUTIVE,SUPER_ADMIN,RECEPTIONIST])`) on the client AND enforced server-side by `OpsDashboardRead` on every position read/stream. Mechanic share control is `isMechanic`-only.

---

## (2) MIGRATIONS (first step — D-map-0)

Numbered after the latest (current head is 0047 in working tree → use 0048+). All copy the 0042 pattern verbatim: `org_id NOT NULL REFERENCES organizations`, `PRIMARY KEY (..., org_id)` or `(org_id, user_id)`, `ENABLE`+`FORCE ROW LEVEL SECURITY`, `CREATE POLICY org_isolation USING/WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true),'')::uuid)`, `trg_*_org_immutable` trigger, GRANT to `mnt_rt`.

- **`0048_add_ping_motion_fields.sql`** — `ALTER TABLE location_pings ADD COLUMN heading_deg double precision, ADD COLUMN speed_mps double precision, ADD COLUMN battery_pct smallint` (all NULLable, backward-compatible; CHECK 0–360 / 0–100 where bounded). Touches a partitioned table — apply to parent.
- **`0049_create_user_duty_status.sql`** — `user_duty_status(id, org_id, user_id, branch_id, on_duty bool NOT NULL DEFAULT false, since timestamptz, updated_at timestamptz, UNIQUE(org_id,user_id))` + RLS/FORCE/trigger + GRANT. This is an **audited** table (duty.on/duty.off are work facts that survive withdrawal — mark `mnt-gate: audited-table user_duty_status`).
- **`0050_create_mechanic_live_positions.sql`** — `mechanic_live_positions(org_id, user_id, branch_id, latitude, longitude NOT NULL, accuracy_m, heading_deg, speed_mps, on_duty bool, recorded_at, updated_at, PRIMARY KEY(org_id,user_id))` + RLS/FORCE/trigger + `INDEX(org_id, branch_id)` + GRANT. **NOT audited** (location-derived, droppable — like `site_geofence_presence`); hard-deleted on withdraw + duty-off.

---

## (3) SEQUENCED BATCHES (each independently committable on the live branch; sequential checkout because ko.ts/openapi/realtime are shared; per-batch gate = `cargo fmt && cargo clippy && cargo test` run as `mnt_rt` + `npm lint/build/test` + openapi lint + `clients` regen where the schema moved)

### D-map-1 — Routing proxy + draw-a-route (VALUE FIRST, zero new tables, no privacy surface)
- **Backend:** new `RoutingProvider` trait + `OsrmRoutingProvider` (calls public OSRM or self-hosted) in dispatch (or a small `platform/routing` crate). `POST /api/v1/dispatch/route` in dispatch/rest, `OpsDashboardRead`-gated, validates lat/lon bounds, returns `{ coordinates, distance_m, duration_s }`. Provider chosen by `MNT_ROUTING_PROVIDER` env; Kakao/Google = `todo!()`-free stubs returning `Unimplemented` until keyed.
- **Web:** `web/src/features/maps/{MapProvider.ts, RoutingProvider.ts, osrm.ts→callsProxy, kakao.ts, google.ts, index.ts}`; `RouteEtaChip.tsx`. DispatchMapPage: click a site → call proxy → draw dashed `Polyline` + ETA chip (`now+duration` Asia/Seoul via `formatKoreanDateTime`), `[경로 지우기]` clears, one route at a time.
- **openapi/clients:** add `/dispatch/route`; regen ts + swift.
- **ko.ts:** `ko.dispatchMap.{eta, etaArrived, showRoute, clearRoute, distanceKm, durationMin}`.
- **Tests:** Rust unit (OSRM response → struct mapping), rest test (auth gate 403 for non-OpsDashboardRead), web test (chip renders `12분·4.2km·도착 14:25`).
- **Acceptance:** a dispatcher clicks any geocoded site, sees a real road polyline + ETA; no key in the web bundle (proxy only); MECHANIC gets 403.

### D-map-2 — Migrations + duty state + server-owned gate
- **DB:** apply 0048/0049/0050 (D-map-0 above bundled here as the batch's first commit step).
- **compliance/domain:** extend `LocationPing` (heading/speed/battery); add `DutyStatus` FSM (off↔on).
- **compliance/adapter-postgres:** add `user_duty_status.on_duty=true` check beside the consent `FOR SHARE` in `record_location_ping`; add audited `transition_duty(on|off)`; on duty-off delete `mechanic_live_positions` for the user (and add it to the withdrawal DELETE block at :211–233).
- **compliance/rest:** `POST /api/v1/duty/on`, `/duty/off`, `GET /api/v1/duty/status` (self-only, Login-gated); add `heading_deg/speed_mps/battery_pct` to `LocationPingRequest`.
- **dispatch/adapter-postgres:** swap presence proxy (1084–1092) to `JOIN user_duty_status WHERE on_duty`.
- **Tests (as `mnt_rt`):** ping with consent-GRANTED but duty-OFF → 403; duty-ON+consent → inserts; org-B-armed read of `user_duty_status` returns zero rows; duty.on/off emits audit; withdrawal still erases pings.
- **Acceptance:** location physically cannot flow unless server sees `GRANTED ∧ on_duty`; duty transitions audited; missing duty row = fail-closed off.

### D-map-3 — Live-position write + stream (the realtime half)
- **compliance/adapter-postgres:** in the same armed tx as the ping insert, upsert `mechanic_live_positions` (`ON CONFLICT (org_id,user_id) DO UPDATE` only when newer `recorded_at` — monotonicity guard like geofence presence); after commit `pg_notify('mechanic_position', PositionNotifyPayload)`.
- **platform/realtime:** add `PositionNotifyPayload`; `RealtimeEvent::MechanicPositionUpdated{position}` + its `branch_id()` (skip thread-membership); `listener.listen("mechanic_position")`; `handle_position_payload` (arm payload.org → read the row + join `users.display_name` → `dispatch_event`); add subscription selector `?subscribe=positions` on `ConnectionSlot`; add `can_view_live_positions: bool` (from OpsDashboardRead) to `RealtimePrincipal` parsed in `principal_from_claims`; snapshot-on-connect burst; capability gate in `dispatch_event` for this variant.
- **compliance/rest (or dispatch/rest):** `GET /api/v1/dispatch/live-positions` snapshot (branch-scoped, OpsDashboardRead).
- **Audit:** on positions-subscribe write ONE `location.live_view.start` row (coordinate-free), `.stop` on disconnect.
- **openapi/clients:** document `?subscribe=positions` on `/ws`, the `mechanic_position_updated` frame, `/dispatch/live-positions`.
- **Tests (as `mnt_rt`, the highest-risk gate):** org-A ping → org-B-armed snapshot returns zero; WS fan-out delivers nothing to org-B / out-of-branch / non-OpsDashboardRead principal; mechanic principal receives no positions; snapshot honors 10-min freshness; out-of-order ping doesn't regress the row.
- **Acceptance:** a second device armed as another org/role sees nothing; a dispatcher sees live `mechanic_position_updated` frames.

### D-map-4 — Mechanic sender + duty/share UI
- **web/src/features/location:** `useGeolocationPermission.ts` (permissions/geolocation wrapper: granted|denied|prompt|retry); `useLocationSender.ts` (state machine IDLE→ACQUIRING→SENDING⇄PAUSED→STOPPED; `watchPosition`; distance(25 m)+time(15 s floor / 60 s heartbeat)+accuracy(>100 m drop) gate; POST with motion fields; 403→STOPPED+refetch consent; visibilitychange→PAUSED; re-check consent on resume + 60 s `/duty/status` poll); `MechanicShareControl.tsx` (duty switch + persistent "● 위치 공유 중" indicator + 4-pillar transparency block + permission-denied banner distinct from consent).
- **Pages:** mount `MechanicShareControl` on `/dispatch` for `isMechanic` and on `/settings/location`; top-bar persistent sharing chip in the shell.
- **ko.ts:** the `ko.location` additions (onDuty/offDuty/sharing/shareList{what,who,howLong,retention,stop}/permissionDenied/…).
- **Tests:** sender FSM transitions; off-duty/withdraw/hidden → clearWatch + final `on_duty:false`; permission-denied surfaces banner without withdrawing consent.
- **Acceptance:** a mechanic toggles 근무 중 + grants → live pin appears on the dispatcher map; toggling off / withdrawing / backgrounding drops the pin within seconds; mechanic always sees a visible "sharing" signal.

### D-map-5 — Dispatcher live map UI (markers, list, follow, route-to-assignment)
- **web/src/features/dispatch:** `useLiveMechanics.ts` (WS `subscribe=positions` mirroring `realtime.ts` + poll fallback to `/dispatch/live-positions` + staleness derivation); `LiveDispatchMap.tsx`, `MechanicMarker.tsx` (rotated chevron by `heading_deg`, shape+color status, fade past freshness), `AssignmentList.tsx` (map-synced list / mobile bottom sheet, `aria-pressed` two-way sync, the AT fallback), `LiveStatusChip.tsx` (`role="status" aria-live="polite"` 연결됨/지연/오프라인), `MapFilters.tsx` (clone WorkOrderFilters). Route to a mechanic's *assigned site* reuses D-map-1's proxy. Sub-gate the live layer to non-MECHANIC.
- **ko.ts:** the `ko.dispatchMap.live{…}` block (statuses, legend, follow/following/unfollow, noOnDuty, privacyFootnote).
- **Tests:** marker shape/rotation by status; list↔map selection sync; stale mechanic mutes independently; non-dispatcher sees sites only.
- **Acceptance:** Uber/DoorDash-style live map — live mechanics never cluster, follow-lock releases on manual pan, single active route + ETA, last-seen age always visible, list is fully keyboard/AT navigable.

### D-map-6 — Retention/auto-off worker + polish (closes the PIPA gap)
- **platform worker:** daily `tokio::time::interval` per-org armed (`with_org_conn`) → `purge_expired_location_data(now - RETENTION)` (RETENTION = 30 d, **confirm with stakeholder**); auto-duty-off for users whose last ping > 30 min; purge `mechanic_live_positions` older than 24 h.
- **Polish:** site/open-WO clustering (mechanics excluded), legend, empty/loading/error states, mobile bottom sheet, a11y final pass.
- **Tests:** purge drops expired partitions O(drop), not giant DELETE; auto-off flips stale on-duty; live-position TTL purge.
- **Acceptance:** raw pings auto-expire; a forgotten on-duty session auto-clears; no orphan live pins.

---

## (4) PRIVACY/SECURITY CHECKLIST (per backend batch)

- **D-map-1:** routing proxy is `OpsDashboardRead`-gated; **no provider key in the browser bundle** (proxy-only, key server-side env); lat/lon validated.
- **D-map-2:** server-owned `GRANTED ∧ on_duty` gate enforced inside the armed tx (client boolean is not trusted); duty transitions audited; fail-closed on missing duty row; withdrawal still erases pings.
- **D-map-3 (highest risk):** every listener/snapshot read arms org from NOTIFY payload / principal (`with_org_conn`); pool stays `mnt_rt` NOBYPASSRLS; **verify cross-tenant negatives as `mnt_rt`, never a BYPASSRLS superuser test** (per `rls-verify-as-runtime-role` memory); NOTIFY payload carries IDs+org only (8 KB-safe, no coordinates in NOTIFY/audit); position fan-out gated by org(RLS)+branch_scope+OpsDashboardRead; viewer-session audit `location.live_view.start/stop` is coordinate-free.
- **D-map-4:** sender re-checks consent on resume + 60 s poll (mid-shift remote suspend stops local watcher ≤1 min); device-permission-denied ≠ consent-withdrawal (surfaced separately); foreground-only (no background buffering).
- **D-map-5:** live layer client-gated to non-MECHANIC and server-enforced by OpsDashboardRead; persistent PIPA footnote on the map.
- **D-map-6:** retention purge actually scheduled (closes the unscheduled-`purge_expired_location_data` gap); auto-off backstop; live-position TTL.

---

## (5) OPEN RISKS

1. **OSRM prod caveat** — the public demo OSRM (`router.project-osrm.org`) is rate-limited and not for production. D-map-1 ships keyless but you must self-host OSRM (or accept demo limits for pilot) before real load; Kakao Mobility is the recommended production swap (one REST key, generous free tier, best KR roads). Decision needed before go-live, not before D-map-1.
2. **Kakao key provisioning** — needs a Kakao Developers app + REST key in OCI Vault + `mnt-secrets` (mirror the mail-key flow in task #28) before the Kakao `RoutingProvider` impl is wired. Google stays a stub until KR in-country driving directions are available.
3. **PIPA retention period to confirm** — REALTIME proposes 30 d for raw pings / 24 h for live positions; **confirm the exact 보존 기간 with the stakeholder/위치정보법 posture** before D-map-6 hard-codes it. The `{days}` in `ko.location.shareList.retention` must track whatever is chosen.
4. **Migration numbering** — working tree already has `0047`; confirm no parallel branch grabbed 0048–0050 before merge (sequential checkout on this shared branch mitigates).
5. **`RealtimePrincipal` change is shared with the messenger path** — adding `can_view_live_positions` and the subscription selector touches the one hub serving both MessengerPanel and DispatchMap; D-map-3 must keep messenger replay (cursor) behavior byte-identical (regression test the existing messenger WS in the same batch).

Key files (absolute): `/Users/jasonlee/Developer/maintenance/backend/crates/compliance/adapter-postgres/src/lib.rs` (record_location_ping:251, withdrawal DELETE:211), `/Users/jasonlee/Developer/maintenance/backend/crates/compliance/rest/src/lib.rs`, `/Users/jasonlee/Developer/maintenance/backend/crates/compliance/domain/src/lib.rs`, `/Users/jasonlee/Developer/maintenance/backend/crates/platform/realtime/src/lib.rs` (RealtimeEvent:173, RealtimePrincipal:226, dispatch_event:587), `/Users/jasonlee/Developer/maintenance/backend/crates/dispatch/adapter-postgres/src/lib.rs` (presence proxy:1074–1094), `/Users/jasonlee/Developer/maintenance/backend/crates/platform/db/migrations/0042_create_site_attendance.sql` (RLS pattern to copy), `/Users/jasonlee/Developer/maintenance/web/src/pages/DispatchMapPage.tsx`, `/Users/jasonlee/Developer/maintenance/web/src/features/location/location-consent-state.ts`, `/Users/jasonlee/Developer/maintenance/web/src/features/messenger/realtime.ts`, `/Users/jasonlee/Developer/maintenance/web/src/i18n/ko.ts`, `/Users/jasonlee/Developer/maintenance/backend/openapi/openapi.yaml`. New migrations: `0048_add_ping_motion_fields.sql`, `0049_create_user_duty_status.sql`, `0050_create_mechanic_live_positions.sql`.