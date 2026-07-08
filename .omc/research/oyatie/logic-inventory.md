# Oyatie Console.dc.html — Logic inventory (class Component extends DCLogic, lines 3415–7868)

Constructor 3416–3905 (state literal 3615–3904), methods 3907–5860, renderVals() 5862–7867.

## 1. Data model

### Instance constants
- WEEK_DATES: 7 ISO dates 2026-06-29..07-05, "today"=07-03.
- ICONS: ~50 SVG paths. KINDS: approval|dispatch|work|support → {label 결재/배차/정비/회신, chip colors, primary action, whoLabel 기안/배정/담당}.
- ENTITIES: hq|coss|knl|bestec|staff (hq = group-common, always visible in every scope).
- MEMBERS[6] {name,team} (mention/approver picker). EMPLOYEES[10] {name,title,team,job,ent,entity,ext,joined,st,tone,note?}.
- HR_ISSUES[3] {id,type 지각|미출근|연장,tone,who,team,ref AT-MMDD-NN,time,detail[],evidence[],links[],ot?} — ot requires reason+linked work scope to resolve.
- DRIVERS[2]. PEOPLE{name→{title,team,entity,ext,email,joined,me?,thread?}} (10).
- ATT_SITES[6] {id,site,entity,ent,plan,inn,late,absent,tone,note,act?,oi}. WEEK52[4] {who,team,cur,proj,tone}.
- PAY_EX[5] {id px1-5,who,team,type 연장수당|소급 인상|결근 공제|일할 계산|계좌 확인,tone,amt,oneline,lines[],chips[{kind,label,hr?|thread?|person?}],noPerson?} — cross-object backlinks. PAY_ROWS[10] {who,title,entity,ent,base,allow,ded,net,delta,dTone,ex?→PAY_EX}. PAY_ENT_COST[4]. ENT_ORDER ["coss","knl","bestec","staff"].
- CARD_META/CARD_TITLES/CARD_PRESETS: workspace zones per screen (hr: roster/issues; review: teams/tasks; att: board/ex/close/w52; pay: reg/ex/cost/sched), presets default 63:37|focus 74|compare 50:50|stack. zoneRefs.
- Method-hosted: APPR_TEMPLATES[8] (4631: ot/leave/expense/sub/purchase/benefit/reimburse/general), apprReasons(tid) enum per template (4650), apprLinkSpec(tid) {label,req,opts} (4664 — benefit REQUIRES payee target), apprDefaultLine(tid) (4691), benefitData() {legal[10],extra[11] w/ tiers/lifecycle} (4928), benefitLifeMeta FSM draft→pending→finalized→implemented→retiring→retired (5017), DOCS()[10] {code AP-/JL-/NT-/C-/IN-,type,keep 3년|5년|10년|영구} (4973), POLICIES()[6] Cedar-like {rule NL, principal, action, resource, effect 허용|금지, status, by, when} (4988), STEP_ROLES 검토/승인/합의/참조 (6427), TAG_CATALOG (6493).

### state (mutable, 3615–3904)
- Shell: themeMode, vw/vh, sbUser, railUser, scope("all"|entity), screen (overview|hr|recruit|org|review|att|pay|leave|benefit|appr|docs|policy|inbox|audit|auto), railSec, railView.
- HR: hrQ/hrF/hrSel/hrHandled/hrOtHours("2시간")/hrOtPlan.
- Att: attSubbed, att52Handled, attCossClosed (month-close gate), attView day|month, attMonth(6|7), attPath (drill index path), attDayCols int[5]|null.
- Appr: apprTab(inbox|outbox|draft), apprCompose {tid,title,body,line[],targets[{k,v}],targetMenu,reason,err/errT/errR}, apprMySubs[] {id,ref AP-NNNN,title,tmpl,date,status progress|approved|rejected|finalized,line[],step,target?,promoteRound?,receiptDoc?("ext-"+name),auto?,receiptAt?} (seeded AP-3122/3120/3111).
- Docs/policy: docFilter/docQ/policyOpen.
- Leave: leaveHandled{reqId→approve|return|reject}, lvSel, lvReqs[3] {id,who,team,type 연차|반차,days,when,reason,left,ref? AP-3108}, LV_EMP[10] {name,team,grant,used,tone ok|promote|low}, lvPromoteRound{name→1|2}, lvRefusal{name→true}.
- Benefit: benefitTab(legal|extra)/benefitOpen/benefitLife{name→lifecycleKey}.
- Org: orgEdit, orgOpen int[], siteOpen ["ci-si"], entCard, teamCard {name,head,hc,path}, orgData[4] {ent,meta,sites[{name,hc,teams[{name,head,hc}]}]} — 1,284 total.
- Recruit: quickOpen/quickScope, rcOpen/rcActFor, rcData[5] {id,role,ent,site,need,hired,due,rejected?,cands[{id,name,st 0-3 접수/서류/면접/오퍼,d,hold?,docReq?}]}.
- Work items (unified inbox, 3757–3768): filter, selectedId, items[9] {id,kind approval|dispatch|work|support,urg now|today|wait,ref AP-|WO-|CS-,title,entity,site,who,due,dueTone,amount?,submitted?,detail[],files[{name,size}],links[{kind,label}],stats{spark[6],summary,delta,tone}?,mailId?,done,doneLabel?,doneTone?} — CORE object contract.
- Modal/panels: punchedOut, modal{type kind|"hrissue"|"mail",id}, mComment/mErr/mDriver/mAddOpen/mAddRole/mExtraApprovers[{role,name}]/mMyRole("승인")/mRoleMenuFor, personName, mTags[{kind,label}]/mTagOpen, docked[] {id,type,comment,tags,extras,driver,myRole} (tray drafts), panels[] {key,quads[tl|tr|bl|br],pkind task|mail|person|cal|ent|team,...payload (id/type/comment/driver | mailId/reply | name | ci | team)}, dragSnap/dragZone/dragSnapKind.
- Calendar/todos: calOpen/calMonth/calSelDate/calAddVal/selDay(0-6), schedByDay[7][] {id,type ev|todo,t,title,sub?,who "@name"?,due?,scope{kind 팀|사업장|법인,label}?,links[{ref,itemId}],done}, quickVal, mentionOpen/Q.
- Comms: activeThreadId/activeMailId/composerVal/cMention*/replyVal, threads[3] {id,name,unread,msgs[{me,from,t,text}]}, mails[4] {id,from,subj,time,unread,tag CS-nnn?,itemId?,replied,body[]}, notifs[5] {id,cat 결재|멘션|문서|공지|근태|급여,text,time,unread,link{item?|thread?|screen?}|null}, notices[3] {id,title,meta,unread}.
- Personal inbox: inboxFilter(action|pay|done|all), inboxSel, inboxView, pkModal{docId}, pkPhase(idle|scanning|done), inboxDocs[5] (3892–3898) {id,kind contract|rule|pay|promote|refusal,ref DOC-|AP-|PS-,title,from,date,legal:bool,basis? "근로기준법 §17/§94",confirmed null|{by,at},body[]?,net/base/allow/ded/payDate/delta/dTone? (payslips),links[{kind,label,to? pay|att|notice}]} — legal && !confirmed ⇒ passkey-locked.
- Automation: autoTab(workflow|schedule), autoSel/autoSchSel/schEdit/schEditVal, workflows[4] (3844–3861) {id,name,active,runs,lastRun,lastResult,trigger{label,icon},when[{label}],then[{label,icon}]} (wf1 무단결근→소명AP, wf2 연차촉진, wf3 연장승인→근태·급여 반영, wf4 계약만료 D-30), schedules[5] (3862–3868) {id,name,cronLabel NL "매일 17:00",cron "0 17 * * *",next,last,active,lastResult ok|warn,history[{t,result,note}]}.
- Audit: auditFilter(all|workflow|view|forbid|anomaly|policy|sensitive), auditScope (correlation|null), auditQ/auditOpen/auditSel, auditEvents[16 seed] (3874–3891) {id,day,t HH:MM:SS,actor,actorInit,action Korean verb,cat view|forbid|submit|system|finalize|policy|auth|approve|return|reject|receipt,target{type,label,code?},decision permit|forbid|self,reason?,anomaly?,before?/after?,session,ip}.
- Payroll FSM: payCalcing/payCalced/payExDone{pxId→ok|hold}/payExOpen/paySubmitted/payQ; derived payApproved/payRejected from item pa1.
- Workspace persistence: cardLayout{scr→{main[],side[],h{id:px},split .42-.78}}, quickCards[{scr,id}], cardDrag/cardHover/cardSplitMenu, cardMode{scr→null|{kind max|modal|split,id,dir}}, layMenuFor, cardMin[{scr,id}], cardFloat{"scr:id"→{x,y,w,h,ax left|cx|right|null,ay top|cy|bottom|null,pinned?,dock? right|bottom}}.
- Misc: paletteOpen/Q/Idx, toast{text,undo}, lastAction{itemId}, pAdminOpen, pDetailOpen.

## 2. Methods by domain

- Work inbox: scopedItems 3976 (entity===scope||"hq"), visibleItems 3980, pendingOf 3984, setItemDone 3992 (mutates + removes panel + lastAction), openDetail 4000 (docked→restore; approval/dispatch→snap panel right; support→rail mail), rowAct 5502, approveFromModal 5514 (NO logEvent — gap; pa1 special-case pushes 급여 이체 예약 notif), returnFromModal 5530 (comment required), confirmDispatch 5550, dismissNotifFor 5561, undoLast 5565, mapItem 5822 (row VM incl. dragStart token "[REF title]", dragKind="obj").
- Panels/snap: snapTo(zone,entry,quiet) 4043 — zone→quadrant map, source inference (cal>teamCard>entCard>person>mail>task), evicts overlapped panels to docked, dedupes, appends {key,quads,...}; snapDrop 4026 (task/mail only, else toast); panelUpdate/panelDecide/panelMailReply/panelPopup 4093–4140 — panelDecide EMITS logEvent (승인/반려/거부/배차 확정, reason=comment); panelMailReply sets mails[].replied + completes linked item; dockModal 4158/restoreDock 4169 (blocked if handled).
- Card engine: mergeCardLayout 4278 (sanitize persisted vs CARD_META, split clamp 0.42–0.78), persistCards 4299 (localStorage oyatie-cards-v1), computeCardLay 4358 (min-height scaling, narrow <1024 or panels-open, modes max/modal/split, cached _layCache), cardVal 4439, cardToolVals 5342, cardDropVals 4481, cardGrab 5194 (header ≤54px only, ignores interactive elements; <1024 → pinRight), cardDragMove/End 5222/5244, startFloatDrag 5097 (16px grid, magnet anchors, tray-drop=minimize), cardResizeStart 5264, cardCornerStart 4558 (corner + split snap stops .5/.63/.74), cardSplitStart 4530, attDayColStart 4501 (col resize, min widths, 8px grid), cardMinToggle 4303, cardFloatToggle 4315, cardPinRight 5145 (right dock ≥1024, bottom below; body pad reserved in renderVals 6144–6152), cardPopOut 5170, cardRestoreDefault 5185, cardModeSet 5329, cardQuickToggle 5336, applyPreset 5086, layCustom 4332, cardLayoutReset 4341.
- HR/att: openHrIssue 4206, hrResolve 4210 (OT requires comment+hrOtPlan; NO logEvent — gap), attIssuesLeftN 4225, attConfirmClose 4227 (gate all handled; notif na1 → pay), attStatus 5396 (deterministic per-person day status via FNV h32 5390 + overrides), buildAttMonth 5413 (synthesizes 1,284-person month grid from orgData, roll-up team→site→ent→root, memoized _attM), hrFiltered 5497.
- Payroll: payRunCalc 4236 (requires attCossClosed, 1.4s timer), payExAct 4245, paySubmit 4256 (requires all 5 exceptions → creates approval item pa1 AP-3124 ₩41.8억 1,284명 prepended to items + notif na2), payResubmit 4273.
- Approvals: apprOpenCompose/AddTarget/RemoveTarget/apprSubmit 4644–4716 (validation title/targets per apprLinkSpec/reason; ref AP-(3123+len); NO logEvent — gap), apprFinalize 4958 (→finalized, logEvent 종결 cat finalize), apprRevoke 4966 (audit-team post-approval reject: status→rejected, line += "감사팀 사후 반려", toast cites Cedar; NO logEvent — gap), lvDecide 4718 (logEvent 승인/반려/거부 type 연차 code r.ref).
- Leave §61: lvPromotePush 4891 (round 1→2 via lvPromoteRound; creates AP- sub {tmpl 연차촉진, line [상신, 인사팀 승인, name 수령확인 대기], step 2, target, promoteRound, receiptDoc "ext-"+name} + notif + logEvent 상신 cat submit reason "근로기준법 §61"), lvRefusalPush 4910 (tmpl 노무수령거부, 대표이사 승인 line; sets lvRefusal; logEvent).
- Inbox/passkey: inboxOpen/Select/ViewDoc/Back/DocOf 4844–4848, inboxLocked 4849 = legal&&!confirmed, pkStart 4851 (only if locked), pkAuth 4858 (idle→scanning 1050ms→done 640ms→inboxConfirm), pkCancel 4857, inboxConfirm 4870 — stamps confirmed{by 전성진,at}; BACK-REF: apprMySubs with receiptDoc===id jumps to final step + finalized + receiptAt (receipt closes approval loop); logEvent 수령 확인 cat receipt decision self reason "passkey 본인확인 · 열람 = 수령 증빙"; inboxLinkGo 4882 (routes to pay|att|notice).
- Audit: auditFiltered 4766 (filter+correlation+fulltext over actor/action/target/reason/device/geo/browser/classification), auditOpenTarget 4782 (직원 → openPerson, else toast).
- Org: orgMoveTeam 4193 (toast "실제 반영은 조직 개편 결재로 상신"), orgAddSite 4999/orgAddEntity 5004/orgRenameSite 5009/orgRenameEnt 5013 — direct mutations, no logEvent.
- Benefit: benefitLifeOf 5029, benefitAdvance 5036 (lifecycle FSM in benefitLife).
- Recruit: rcAdvance 5045 (stage+1; st≥3 → hire: hired=min(need,hired+1), cand removed), rcCandAct 5064 (reject → rejected++ + remove; doc sets docReq; hold toggles).
- Comms/person/cal: openPerson 5491 (logEvent 열람 cat view type 직원 EXCEPT self — policy p3), openThread 5618 (clears unread + linked notifs), sendMsg 5626 (simulated reply t1), openMail 5657, sendReply 5664 (replied + completes linked item), notifClick 5679 (routes item/thread/screen), markAllNotifs 5691, msgParts 5854 (@mention → openPerson), toggleTodo 5572, addTodo 5579 (parses @name → who, [REF-123] → links w/ itemId lookup, quickScope), onQuickChange/pickMention 5600/5605 (org units → scope chips, people → mentions), composer equivalents 5646/5651.
- Shell: showToast 3986 (5.2s, undo), effectiveDark/cycleTheme 5695/5702 (persists oyatie-theme), openPalette/searchResults/paletteKey 5708/5713/5814 (pending tasks + screens — 6 real + stubs — + people), handleKey 5740 (⌘K, Esc cascade: card-modal→cal→teamCard→entCard→person→modal-submenus→modal→rail→pop panel→misc; j/k/Enter on hr/leave/overview), flatPendingIds 5736, sbCollapsed/railCollapsed/mainArea 3936–3944, componentDidUpdate 3946 (re-anchor floats on resize).

## 3. Audit schema (logEvent 4750; standard: NIST 800-53 AU · ISO 27001 · CADF/OCSF)

Event = defaults ⊕ partial:
```
{ id "ev"+rand6, day "오늘", t HH:MM:SS,
  actor 전성진, actorInit 전,
  action <Korean verb>, cat, target {type,label,code?},
  decision permit|forbid|self, reason?,
  session "s-8f2a" (_sess), ip,
  device, browser, geo, auth "passkey (FIDO2)",   // deviceCtx() 4728: device from vw breakpoint, browser from UA, ip 10.20.11.4, geo 창원 본사 · 사내망 (KR), managed
  seq ++_seq (from 100421), trace "tr-"+rand6,
  prevHash (lastHash||0x00000000), hash _evHash(ev) }  // djb2 over seq+t+actor+action+target.label+decision → 0x hex8 chain
```
auditClassify 4740: target label /임원|비밀|인사 명령/ → 비밀; type 급여/법적 문서 → 민감정보; 직원/취업규칙/연차촉진/노무수령거부/정책 → 대외비; else 일반. Seeds also carry anomaly strings + before/after for policy changes. Prepends newest-first.

Wired call sites (9): panelDecide 4110, lvDecide 4724, wfToggle 4803 (cat policy), wfRun 4815 (actor 자동화 엔진 ⚙ cat system), schRun 4832 (actor 예약 작업 ⏱), inboxConfirm 4880 (cat receipt, decision self), lvPromotePush 4908, lvRefusalPush 4925, apprFinalize 4963 (종결); openPerson 5493 (열람 view, skip self).
GAPS (not logged in prototype; real backend must log uniformly): approveFromModal/returnFromModal/confirmDispatch (modal path), hrResolve, paySubmit, apprSubmit, apprRevoke, org edits.

## 4. Cedar PBAC simulation

- POLICIES() 4988: p1 team lead reads own team attendance; p2 forbid cross-entity payroll detail; p3 self-read own payslip un-audited (mirrored: openPerson skips self logEvent; inboxConfirm decision "self"); p4 HR role reads sensitive WITH audit; p5 audit team post-hoc reject finalized approvals (= apprRevoke); p6 dispatch coordinator sees only assigned-site people (draft).
- decision permit|forbid|self on every event; forbid reasons embed rule e.g. "직무 권한 없음 · Cedar: 급여.임원 = deny" (a02 3876, a15).
- Deny-by-omission: no runtime engine — denial exists as seed forbid rows; UI simply doesn't render unauthorized data. Policy editing/simulation stubbed ("Cedar no-code 규칙 캔버스… 다음 단계" 6919–6922; benefit condition editor 7122). renderVals policyRule 6995: forbid → "Cedar forbid 규칙 적용", else "Cedar permit · {classification} 접근 · 기기={device}".
- Scope relativity: scopeDefs 6216 = 그룹 전체 + 4 entities; every list filters scope==="all"||entity===scope||entity==="hq" (items 3978, EMPLOYEES 7616, ATT_SITES 5899, PAY_ROWS 5943) → "group total" = union of authorized entities + group-common. Month drill prefixes path with scope entity index (5994–5997).
- No persona switching; actor fixed 전성진 (임원/그룹 관리자).

## 5. Workflow/schedule simulation

- Workflow = trigger{label,icon} + when[labels] + then[labels] (TCA, declarative labels only) + {active,runs,lastRun,lastResult}.
- wfToggle 4800 (logEvent cat policy, toast 트리거 감시 시작/일시중지), wfRun 4806 — per-id real effects: wf1 _autoAP("무단결근 소명 요청 (자동)","소명",[인사팀 검토 중, 대상자 소명 대기]) → REAL AP- in apprMySubs (ref AP-(3123+len), line[0] 자동화 상신, auto:true) + notif; wf2 → first LV_EMP tone promote not yet promoted → lvPromotePush (full §61 object incl. receiptDoc); wf4 _autoAP 계약 갱신 검토/지출결의; wf3/default toast-only 근태·급여 반영. Then runs++, lastRun 방금, logEvent system. wfSimulate 4818 = dry-run toast joining then labels "(실제 개체 생성 없음)".
- Schedules: schToggle 4823 (toast 다음 시각에 실행), schRun 4828 (history prepend {t 방금, result ok, note 수동 실행} + system logEvent), schEditOpen/Save 4835/4836 — edits cronLabel ONLY (NL string), toast 다음 실행 시각 재계산 (no cron parse).

## 6. renderVals() contract — key groups (5862–7867)

Shell/nav: themeClass/IconD/Title, onThemeCycle, onUser, kbdLabel, bodyOverflow, sbW/sbOpen, navGroups[{label,items[{label,icon,bg,tx,fw,badge,badgeOn,badgeBg/Tx,dotOn,onClick}]}], onSbToggle, collapseLabel/IconD, onPaletteOpen, scopeLabel/Open/onScopeToggle/scopes[], bellOn/bellCount/onBell, quickOpen/onQuickToggle/Close/quickActions[].
Overview: kpis[4]{label,value,sub,colors,onClick}, inboxTotal, filters[], groups[{label,dot,anim,count,items[mapItem]}], notEmpty/inboxEmpty/handledLabel/restoreOn/onUndoAll/showHints; day panel: dayTitle, progressOn/Label/Pct, week[7], sched[], schedEmpty, punchIn/punchMeta/punchBtnOn/onPunchOut, quickVal/onQuickInput/Key/quickAddRef, mentionOpen/mentions[], quickScope{On,Label,Bg,Bd,Tx}/onQuickScopeClear.
Rail: railW/Open/Closed/onRailToggle, onStrip{Msgr,Mail,Alerts}, railHome/Thread/MailRead, msgr/mail dots+counts, threads[]/mails[]/notifs[]/notices[], noticeCount, onNoticeMore/onMarkAll/onNewChat/onNewMail; thread view: threadName/Meta/onBack/msgs[]/composerVal/onComposerInput/Key/onSend/composerRef/cMentionOpen/cMentions[]; mail view: mailSubj/From/Time/Tag/onMailTag/mailBody/mailReplied/NotReplied/replyVal/onReplyInput/Key/Send/mailModalOn/onMailExpand/mailInitial; accordions: sec{Msgr,Mail,Alert,Notice}{Flex,MinH,Disp}/onSec*.
Calendar: calOpen/onCalOpen/Close/Backdrop/calTitle/onCalPrev/Next/calDows/calCells[42]/calSelLabel/calSelItems/calSelEmpty/calInWeek/calOutWeek/calAddVal/onCalAddInput/Key/onCalViewToggle.
Modal/panels/dock: modalOn/modalApproval/Dispatch/HrIssue, onModalBackdrop/Close/Dock/Pin, dockOn/dockItems[]/onDockClear, panels[] per-pkind VMs w/ area, zone handlers onZone{TL,TR,BL,BR,Top,Bottom,Left,Right}(+Over*,OverNone), zpOn/Label/Top/Bottom/Left/Right/W/H, dragSnapOn/zoneEdgeOn/onSnapDragStart/End, onDragOver, on{Composer,Quick,Reply,MComment}Drop; modal detail: mKind/mChip*/mRef/mDue/mTitle/mEntity/mSite/mWhoLabel/mWho/mSubmitted/mAmount/mDetail/mLine[]/mAddOpen/onMAddToggle/mAddList/mAddStageAction/Person/mAddRoles/mAddRoleLabel/onMAddBack/wzWrap/mFiles/mLinks/mStatsOn/mSpark{On,Pts,Cx,Cy}/mStat*/mTags/mTagOpen/onMTagToggle/mTagList/onMUpload/mComment/onMCommentInput/mCommentRef/Bd/mErrOn/onMApprove/MReturn/MReject/mDrivers/mConfirm*/onMConfirm/onMWhoClick; hrissue: hrOtOn/otHours[]/otPlans[]/hrCommentLabel/Ph/hrErrText/hrResolveLabel/onHrAsk/onHrResolve.
Screens: scrOverview..scrAuto + wrappers apprScr/docsScr/policyScr/inboxScr/auditScr/autoScr/leaveScr/benefitScr (disp) and hrScr/rvScr/attScr/payScr (pos/flex/vis — mounted).
HR: hrQ/onHrQ/onHrNew/hrRows[]/hrCount/hrEmptyOn/hrFilters[]/hrKpis[4]/hrIssueCount/hrIssues[]/hrPlan[3]/hrAllHandled. Recruit: rcPosts[] nested (stages[4], cands[] w/ onNext/menu actions), rcHead/rcMeta/onRcNew. Org: orgCols[] nested + orgColMin/orgEditOn/ViewOn/EditLabel/onOrgEdit/onOrgAddEntity + entCard (ec*) + teamCard (tc*) VMs. Review: rvTeams[4]/rvTasks[3].
Att: attCloseHead/onAttSheet/attKpis[4]/attSiteMeta/attSites[]/att52[]/attCloseChip*/attCloseRows[4]/attCloseReady/attCloseBlockedOn/Text/attCloseDoneOn/onAttConfirmClose/onAttGoPay/attDayOn/attMonthOn/onAttViewDay/Month/attSeg*/attMonthLabel/onAttMPrev/Next/attMPrevC/NextC/attBoardMeta/Hint/attMColLabel/attCrumbs[]/attMSum/attMRows[]/attMCapOn/Note/attDayGrid/attDayMinW/attDayActFull/Mini/attDayCol{h0..h3}.
Pay: payHeadChip*/paySteps[5]/payCta{BtnOn,Label,Bg,Tx,Bd,Anim}/onPayCta/payCtaChip*/payExDot/payExMeta/payGateOn/payCalcedOn/payGateExText/RegText/payGateBtnOn/Label/onPayGate/payExRows[5]/payQ/onPayQ/payCount/payRows[]/payCostTag/payEnts[]/payAcct/paySched[4].
Appr: apprTabInbox/Outbox/Draft/apprHead/apprTabs[3]/apprInbox[]/apprInboxEmpty/apprProgress[2]/apprOutbox[]/apprDrafts[8]/apprCompose*/apprAttach*/apprTarget*/apprReason*/apprComposeLine/onAppr*/apprMobileTabs/apprPaySlips[3].
Docs/policy: docKpis[3]/docFilters[6]/docQ/onDocQ/docRows[]/docCount/onDocExport, policyKpis[3]/policyRows[6]/onPolicyNew.
Inbox+passkey: inboxCount/inboxActionN/inboxFilters[4]/inboxDocsList[]/inboxEmpty/inbSelOn/inboxListView/DocView/onInboxBack/inbSel{ref,title,from,date,kind*,icon,basis,payOn,net,base,allow,ded,payDate,delta*,confirmedOn,confirmedStamp}/inbLockedOn/UnlockedOn/inbBodyOn/inbSelBody/inbLinksOn/inbSelLinks/onInbUnlock/fingerprintIcon/gavelIcon/pkModalOn/pkDoc/pkIdle/Scanning/Done*/pkRingColor/pkTarget*/pkBtnLabel/Disabled/Bg/pkFpOn/pkPulseAnim/pkStatusText/onPkAuth/Cancel/Backdrop.
Audit: auditTodayN/ForbidN/AnomN/ForbidTone/AnomTone/auditScopeOn/Label/onAuditScopeClear/auditQ/onAuditQ/auditFilters[7]/auditCount/onAuditExport/auditGroups[{day,rows[{...full telemetry incl seq/hash/trace/prevHash/policyRule/cls/decCard*/onToggle/onActor/onTarget/onCorrelate}]}]/auditEmpty/auditStandards.
Auto: autoTabWf/Sch/autoTabs[2]/autoWfList[]/autoWfOn/autoWf{name,active,triggerLabel/Icon,runs,lastRun,when[],then[]}/autoWfActiveOn/ToggleLabel/onWfRun/Simulate/ToggleDetail/autoSchList[]/autoSchOn/autoSch{name,cronLabel,cron,next,last,active}/autoSchActiveOn/ToggleLabel/autoSchHistory[]/onSchRun/Edit/schEditOn/Closed/Val/onSchEditInput/Save/Cancel.
Leave/benefit: lvKpis[4]/lvRows[10]/lvReqRows[3]/lvReqEmpty/leavePendingStr/lvPromoteOn/lvPromote[{name,team,left,onWho,pushOn,pushLabel,roundChipOn,roundChip,refusalOn,refusedOn,onPush,onRefusal}], benefitTabLegal/Extra/benefitTabs[2]/benefitRows[]/benefitKpis[3].
Card workspace (per hr/rv/att/pay prefix): {scr}ZoneRef/{scr}ZoneH/{scr}Lay{CardId}/{scr}Drop{On,X,Y,W}/{scr}Tool{On,Pos,X,Y,Btns}/{scr}SplitMenuOn/{scr}SplitOpts/on{Scr}ToolKeep/Leave/{scr}ModalBackOn/on{Scr}ToolRestore/{scr}LayCustom/on{Scr}LayReset/{scr}SplitBarOn/Pct/on{Scr}SplitBar/{scr}LayMenuOn/on{Scr}LayMenu/{scr}LayPresets + trayOn/trayEmptyOn/minChips[]/onLayMenuClose/bodyPadRightPx/BottomPx.
Person: personOn/pName/pInitial/pTitle/pTeam/pEntity/pExt/pEmail/pJoined/pMeOn/pOtherOn/pAdminOpen/pJob/pEmpNo/pKpi*/pWork[]/pDetailOpen/Closed/onPDetailView/onPAdminToggle/pLife[3]/pActions[6]/onPayView/onPersonClose/Backdrop/Msg/Mail/onLogout/punchedOutOn.
Palette/toast: paletteOpen/Q/onPaletteInput/Key/paletteRef/pResults[]/pEmpty/onPaletteBackdrop, toastOn/toastText/toastActionOn/onToastAction/onToastClose.

## 7. Persistence (localStorage)

- oyatie-theme: "light"|"dark" (cycleTheme 5705, read 3419).
- oyatie-cards-v1: {lay: cardLayout, quick, min, float, dayCols} (persistCards 4299, read 3611, sanitized by mergeCardLayout; floats re-anchored on resize). Real backend must own workspace state per-user; everything else resets per session.
