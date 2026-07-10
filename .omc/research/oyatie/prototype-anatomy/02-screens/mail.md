# Oyatie Console — Spec for MAIL

File: `docs/design/oyatie-console/Oyatie Console.dc.html` (Jul-4 09:04 mirror, 7,871 lines).

## ⚠ Verification status — read first

The change log (AGENTS.md:43, entry "2026-07-04 (9)") records a **mail full view `screen:"mail"`** built later on Jul 4. The repo's dc.html mirror was saved at 09:04, **before** entries (5)–(9): `grep '"mail"'` over the file finds **no `screen:"mail"`** — only `modal.type==="mail"` and `railSec==="mail"` (lines 4023, 4061, 6839, 7687–7690, 7724). All 17 worktree copies are byte-identical (698,646 B). So:

- **§1 below is snapshot-VERIFIED**: mail as a **right-rail section + rail read view + center modal + pinned split panel** (the pre-full-view surface).
- **§2 is UNVERIFIED against code** (changelog-level only): the 3-pane full view, 13-mail seed, folders, security/governance chips, composer + egress gate, threading.

---

## 1. VERIFIED — snapshot mail surface (rail + modal + pin panel)

Mail is not a `screen`; it lives in the right communication rail (`railView`), a center modal (`modal:{type:"mail"}`), and the 4-quadrant pin-panel system (`panels[]` with `pkind:"mail"`).

### 1.1 Layout anatomy

- **Rail "메일" section** (template 2469–2493): collapsible section between 메신저 and 알림 in the rail home view. Header row (2470–2478): envelope icon + "메일" label + unread-count chip (`{{mailCountOn}}`/`{{mailCount}}`, 2473) + spacer + pencil "새 메일 쓰기" button (`onNewMail`, 2475). Body (2479–2492): `sc-for {{mails}}` → each row is a **draggable button** (`ml.onDragStart`, 2481): unread dot (`ml.dotOp`, 2482) · from + mono time (2485–2486) · subject (2488); font-weight `ml.fw` bolds unread. Section expand/collapse accordion driven by `secMailFlex/MinH/Disp` + `onSecMail` (2469–2479 ↔ renderVals 7687–7690: `railSec===null` = all sections visible, `railSec==="mail"` = mail takes `1 1 auto`, others collapse to 0).
- **Rail "mail read" view** (`{{railMailRead}}`, 2588–2633; `railView==="mailread"`): header = back button (`onBack` → `railView:"home"`, 2591) · "받은 메일" label · **"크게 열기"** button (`onMailExpand` → center modal, 2596–2599). Body: subject (2602) · from + mono time (2604–2605) · optional purple **tag chip** `{{mailTag}}` ("CS-118 연결") with link icon, click `onMailTag` → jump to the linked work item (2606–2611) · body paragraphs `sc-for {{mailBody}}` (2614–2616). Footer (2619–2632): if `mailReplied` → green ok banner "회신 발송 — 연결된 업무가 완료 처리됐습니다" (2620–2625); else quick-reply input (`replyVal`/`onReplyInput`/`onReplyKey`/`onReplyDrop` — drop accepts drag tokens) + "회신" button (`onReplySend`) (2626–2631).
- **Mail center modal** (`{{mailModalOn}}`, 3085–3133): backdrop (3086, `onModalBackdrop`) · dialog `min(680px,94vw)` (3087). Header strip is **draggable to snap** (`onSnapDragStart/End`, title "끌어서 화면에 분할 고정", 3088): info-tone "메일" chip · mono time · same tag chip/`onMailTag` (3091–3096) · close (3098). Body: `h2` subject (3103) · avatar initial `{{mailInitial}}` + from + fixed "받는 사람 · 전성진 (경영지원팀)" (3104–3110) · body paragraphs (3111–3115). Footer on canvas background (3117–3130): replied banner or reply input (placeholder "회신 입력 · 화면의 업무를 끌어다 놓아 참조 첨부") + "회신" (3124–3129).
- **Pinned mail panel** (`{{pn.isMail}}`, template 266–291): inside the generic quadrant panel chrome — avatar + from + "받는 사람 · 전성진" (267–273), body paragraphs (274–278), replied banner "회신 발송 완료" (279–284) or quick-reply input + "회신" (285–290). Panel chrome supplies popup/close buttons (binding 6569–6570).

### 1.2 Interactive affordances

| Affordance | Handler | Effect |
|---|---|---|
| Rail section header | `onSecMail` (7690) | toggle `railSec` accordion between `null`⇄`"mail"` |
| 새 메일 (pencil) | `onNewMail` (6793) | **stub**: toast "새 메일 작성은 다음 단계 범위입니다" |
| Rail mail row | `mails[].onOpen` (6379) | `openMail(id)` (5657): `railView:"mailread"`, `activeMailId`, mark read |
| Rail mail row drag | `mails[].onDragStart` (6376) | drag token `"[메일 "+subj+"]"` (`dragKind="obj"`) — droppable into composers/reply inputs |
| 크게 열기 | `onMailExpand` (7725) | `modal:{type:"mail"}` (rail read → center modal) |
| Tag chip (CS-…) | `onMailTag` (6812) | jump to linked item: `filter:"all"`, `selectedId=itemId`, `railView:"home"`, close mail modal |
| Reply input | `onReplyInput`/`onReplyKey` (6835–6836) | update `replyVal`; Enter → `sendReply()` |
| Reply input drop | `onReplyDrop` (7722) | append drag token to `replyVal` |
| 회신 | `onReplySend` (6837) | `sendReply()` (5664) |
| Modal header drag → snap zone | `onSnapDragStart` (7699) + `snapTo` (4061–4063) | converts mail modal → pinned panel `{pkind:"mail", mailId, reply}` (dedup 4078) |
| Panel reply | `pn.onReplyInput/Key/Send/Drop` (6565–6568) | per-panel `reply` state → `panelMailReply(key)` (4115) |
| Panel popup | `pn.onPopup` (6569) | panel → back to center modal (restores `activeMailId`, `replyVal`) |
| Panel close | `pn.onClose` (6570) | remove panel |
| 내 업무 support row open | `openDetail` support branch (4014–4016) | support item (`kind:"support"`) opens its mail in rail read view via `it.mailId` |
| Support row drag → snap zone | `snapDrop` (4032–4033) | pins the mail as a `pkind:"mail"` panel directly |

### 1.3 State read / written

- **Read**: `s.mails`, `s.activeMailId`, `s.replyVal`, `s.railView`, `s.railSec`, `s.modal` (`type:"mail"`), `s.panels[]` (`pkind:"mail"` entries carry own `mailId`/`reply`).
- **Written**: `mails[].unread` (openMail/openDetail mark-read, 5660/4016), `mails[].replied` (sendReply 5669 / panelMailReply 4119), `replyVal`, `activeMailId`, `railView`, `railSec`, `modal`, `panels`. **Cross-object side-effect** (5670–5673, 4121–4124): if the mail has `itemId`, reply ⇒ `setItemDone(itemId,…,"회신 발송","ok")` + `dismissNotifFor(itemId)` + toast "CS-118 회신 발송 — 업무 완료 처리" — replying to a customer mail completes the linked 내 업무 support item.
- Unread badge: `mailUnread = s.mails.filter(m=>m.unread).length` (5874) → `mailCount/mailCountOn/mailDotOn` (6785–6787).

### 1.4 Seed-data shape (backend contract)

**`mails` seed** (constructor 3810–3822) — **4 mails** (13-mail seed is post-snapshot, §2):
```
{ id: string,          // "m1".."m4"
  from: string,        // "대한제강 구매팀" | "국민건강보험공단" | "그룹 보안팀"
  subj: string,
  time: string,        // "10:12" | "어제"
  unread: boolean,
  tag?: string,        // "CS-118" — linked-object ref chip (only m1/m2)
  itemId?: string,     // "s1"/"s2" — 내 업무 support item id (reply completes it)
  replied: boolean,
  body: string[] }     // paragraphs
```

**Linked `items[]` `kind:"support"` entries** (3764, 3767): `{ id:"s1", kind:"support", urg, ref:"CS-118", title, entity, site, who, due, dueTone, mailId:"m1", done:false }` — the mail↔work-item pairing is by `mailId`/`itemId` cross-reference.

### 1.5 renderVals bindings

- `mails` (6374–6380): from/subj/time, drag-token onDragStart, `fw` (800/500 by unread), `dotOp` (1/0.15), `onOpen`.
- `activeMail` lookup (6411); `mailSubj/From/Time` (6807–6809); `mailTag` = `tag+" 연결"`, `mailTagOn` (6810–6811); `onMailTag` (6812); `mailBody/mailReplied/mailNotReplied/replyVal/onReplyInput/onReplyKey/onReplySend` (6831–6837); `mailInitial` (7726).
- `mailModalOn` (7724); `onMailExpand` (7725); `activeDetail()` (4022–4024) and modal binding (6422, 6839) **exclude** `type:"mail"` from the task-detail modal path — mail modal is its own surface.
- Panel binding for `pkind:"mail"` (6553–6571): info-tone "메일" chip, `ref`=time, `title`=subj, `mInitial/mFrom/mBody/mReplied/mNotReplied`, per-panel reply handlers, `onPopup`/`onClose`.
- Rail accordion: `secMailFlex/MinH/Disp` + `onSecMail` (7687–7690).

### 1.6 Methods driving it

- `openMail(id)` (5657–5662): rail read view + mark read.
- `sendReply()` (5664–5677): trims `replyVal`, marks `replied`, completes linked item (see 1.3), toast.
- `openDetail` support branch (4014–4016): support items open as mail.
- `snapDrop` (4026–4041): dragged support item → mail pin panel.
- `snapTo` mail entry (4061–4063) + mail dedup (4078): modal → panel conversion.
- `panelMailReply(key)` (4115–4128): panel-scoped reply, same completion side-effect.
- `panelUpdate` (4093): per-panel reply text.

---

## 2. UNVERIFIED — post-snapshot mail full view (changelog-level, no code in repo)

Everything below is from AGENTS.md change-log entries (single source of post-Jul-4 design state per SYNC-MANIFEST.md:17,29); **no code exists in the repo to verify against**. Line cites are into `docs/design/oyatie-console/AGENTS.md`.

- **`screen:"mail"` full view** (AGENTS.md:43, 2026-07-04 (9)): **mox backend (own front-end) 3-pane** — 7 folders · list · reading pane; **13-mail seed** spanning inbox/sent/draft/archive/spam/trash; **sender-auth security panel** (SPF/DKIM/DMARC · TLS · encrypted storage); **governance**: classification (대외비·민감·격리) · PBAC · retention · litigation hold; attachments → ingest (DX-) / evidence registration; linked-object navigation; **composer** (classification picker · DLP external-send warning · mox SMTP · DKIM signing); spam folder = DMARC-fail phishing example; all reads/sends audited.
- **Composer egress gate** (AGENTS.md:50, 2026-07-08 (1)): `egressDocs` registry · "개체 첨부" lifecycle chips · external recipient × unapproved/sensitive doc = **block panel** + anomaly audit + compliance notification · single CTA. Methods named: `mailAttAdd`, `mailEgressEval`.
- **Attachment = structured, ingest-primary** (AGENTS.md:71, 2026-07-08 (11a)): mail attachment rows structured; primary CTA = ingest (`ingestUpload` creates a real DX-), evidence registration = records-registration prefill.
- **Lifecycle sync** (AGENTS.md:69, (10)): `lcSyncRegistries` keeps `egressDocs` status bidirectionally in sync → mail egress gate reflects document lifecycle transitions.
- **Threading** (AGENTS.md:115, 2026-07-09 (33) ⑦ — **explicitly post-snapshot, UNVERIFIED**): Gmail-style conversation threading — subject-normalization grouping · conversation-count chip on list rows · collapsed prior-message rows in the reading pane. Same entry ⑥: Slack-style per-thread mute (bell toggle suppressing badges/tab counts) on the messenger side.
- **Backend contract** (HANDOFF.md §14, lines 93–103): mox (MIT, Go) via webapi/webhooks + IMAP4 + SMTP submission; enterprise mods = audit on read/send/delete/move/forward/export, Cedar PBAC on mailboxes/delegation (deny-by-omission, passkey for sensitive), retention/litigation-hold/journaling/e-discovery → WORM archiving (§11), outbound DLP scan, Mail=CommObject in the ontology (attachments → DX-/EvidenceRecord, mail ↔ AP- ↔ documents).
