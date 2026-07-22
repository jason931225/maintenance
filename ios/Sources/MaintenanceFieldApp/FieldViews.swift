import Foundation
import MaintenanceAPIClient
import MaintenanceFieldCore
import SwiftUI

struct FieldRootView: View {
    @StateObject var viewModel: FieldViewModel

    var body: some View {
        NavigationStack {
            Group {
                if viewModel.isAuthenticated {
                    FieldAuthenticatedTabs(viewModel: viewModel)
                } else {
                    LoginView(viewModel: viewModel)
                }
            }
            .navigationTitle(Text("app_name"))
            .task {
                viewModel.restore()
            }
        }
        .sheet(isPresented: $viewModel.isCameraPresented) {
            CameraCaptureView { url in
                Task {
                    await viewModel.evidenceCaptured(fileURL: url)
                    viewModel.isCameraPresented = false
                }
            } onCancel: {
                viewModel.isCameraPresented = false
            } onError: {
                viewModel.cameraCaptureFailed()
                viewModel.isCameraPresented = false
            }
        }
    }
}

struct FieldAuthenticatedTabs: View {
    @ObservedObject var viewModel: FieldViewModel

    var body: some View {
        TabView {
            TodayListView(viewModel: viewModel)
                .tabItem {
                    Label("today_title", systemImage: "list.bullet")
                }
                .accessibilityIdentifier(FieldAccessibilityID.todayTab)
            WorkHubTabView(viewModel: viewModel)
                .tabItem {
                    Label("work_hub_title", systemImage: "square.grid.2x2")
                }
                .accessibilityIdentifier(FieldAccessibilityID.workHubTab)
            MessengerTabView(viewModel: viewModel)
                .tabItem {
                    Label("messenger_title", systemImage: "message.fill")
                }
                .accessibilityIdentifier(FieldAccessibilityID.messengerTab)
            OperationsTabView(viewModel: viewModel)
                .tabItem {
                    Label("operations_title", systemImage: "tray.full")
                }
                .accessibilityIdentifier(FieldAccessibilityID.operationsTab)
        }
        .accessibilityIdentifier(FieldAccessibilityID.authenticatedTabs)
    }
}


struct WorkHubTabView: View {
    @ObservedObject var viewModel: FieldViewModel

    var body: some View {
        let summary = viewModel.workHubSummary
        List {
            Section {
                Text(workHubCountText("work_hub_today_count_format", summary.todayWorkCount))
                Text(workHubCountText("work_hub_urgent_count_format", summary.urgentWorkCount))
                Text(workHubCountText("work_hub_target_due_count_format", summary.targetDueWorkCount))
                LabeledContent("location_consent_collection", value: localizedString(summary.gpsMayCollect ? "yes" : "no"))
            } header: {
                Text("work_hub_daily_section")
            } footer: {
                Text("work_hub_daily_footer")
            }

            if let messageKey = viewModel.messageKey {
                Section {
                    Text(LocalizedStringKey(messageKey))
                }
            }

            Section {
                Text(workHubCountText("work_hub_approval_count_format", summary.approvalRelatedCount))
                Text(workHubCountText("work_hub_pending_sync_format", summary.pendingSyncCount))
                Label("work_hub_passkey_required", systemImage: "person.badge.key")
                Text("work_hub_sensitive_note")
            } header: {
                Text("work_hub_sensitive_section")
            }

            Section {
                ForEach(summary.collaborationActions) { action in
                    WorkHubActionRow(action: action)
                        .accessibilityIdentifier(FieldAccessibilityID.workHubCollaborationAction(action.kind.rawValue))
                }
            } header: {
                Text("work_hub_collaboration_section")
            } footer: {
                Text("work_hub_collaboration_footer")
            }
        }
        .accessibilityIdentifier(FieldAccessibilityID.workHubList)
        .navigationTitle(Text("work_hub_title"))
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    Task {
                        await viewModel.refreshWorkHub()
                    }
                } label: {
                    Label("refresh", systemImage: "arrow.clockwise")
                }
                Button {
                    Task { await viewModel.logout() }
                } label: {
                    Label("logout", systemImage: "rectangle.portrait.and.arrow.right")
                }
            }
        }
    }
}

private func workHubCountText(_ key: String, _ count: Int) -> String {
    String.localizedStringWithFormat(NSLocalizedString(key, comment: ""), count)
}

struct WorkHubActionRow: View {
    let action: MobileCollaborationAction

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(LocalizedStringKey(action.titleKey))
                    .font(.headline)
                Spacer()
                FieldChip(key: action.status.fieldLabelKey)
            }
            Text(workHubActionValue(action))
                .font(.subheadline)
            Text(LocalizedStringKey(action.detailKey))
                .font(.footnote)
                .foregroundStyle(.secondary)
            if action.requiresPasskey {
                Label("work_hub_action_passkey_step_up", systemImage: "person.badge.key")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}

private func workHubActionValue(_ action: MobileCollaborationAction) -> String {
    if let count = action.count {
        return localizedString(action.valueKey, count)
    }
    return localizedString(action.valueKey)
}



struct OperationsTabView: View {
    @ObservedObject var viewModel: FieldViewModel

    var body: some View {
        let dashboard = viewModel.mobileOperationsDashboard
        List {
            if let overview = viewModel.mobileOperationsOverview, overview.origin == .cachedAfterFailure {
                Section {
                    Label("operations_cached_fallback", systemImage: "wifi.slash")
                }
            }

            Section {
                LabeledContent("operations_notification_badge", value: localizedString("operations_count_format", viewModel.mobileNotificationInbox.badgeCount))
                LabeledContent("operations_notification_unread", value: localizedString("operations_count_format", viewModel.mobileNotificationInbox.unreadCount))
                LabeledContent("operations_notification_urgent", value: localizedString("operations_count_format", viewModel.mobileNotificationInbox.urgentUnreadCount))
                ForEach(viewModel.mobileNotificationInbox.notifications.prefix(3)) { notification in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(notification.title)
                                .font(.headline)
                            Spacer()
                            FieldChip(key: notification.isUrgent ? "operations_notification_urgent_chip" : "operations_notification_normal_chip")
                        }
                        Text(notification.body)
                            .font(.subheadline)
                        Text(notification.receivedAt.formatted(date: .abbreviated, time: .shortened))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Button("operations_notification_mark_read") {
                            Task { await viewModel.markNotificationRead(notification) }
                        }
                        .disabled(notification.isUnread == false)
                    }
                    .padding(.vertical, 4)
                }
            } header: {
                Text("operations_notification_section")
            }

            Section {
                LabeledContent("operations_approval_count", value: localizedString("operations_count_format", dashboard?.approvalCount ?? 0))
                if let approvals = dashboard?.approvals, approvals.isEmpty == false {
                    ForEach(approvals.prefix(3)) { approval in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(approval.title)
                                .font(.headline)
                            Text(approval.summary)
                                .font(.subheadline)
                            if approval.canExecuteOnMobile == false {
                                Text("operations_approval_unsupported_mobile")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                } else {
                    Text("operations_approval_empty")
                        .foregroundStyle(.secondary)
                }
                TextField(String(localized: "operations_approval_comment"), text: $viewModel.approvalComment, axis: .vertical)
                    .lineLimit(2...4)
                    .accessibilityIdentifier(FieldAccessibilityID.operationsApprovalCommentField)
                Button {
                    Task { await viewModel.queueFirstApprovalForPasskey() }
                } label: {
                    Label("operations_queue_approval", systemImage: "person.badge.key")
                }
                Button {
                    Task { await viewModel.replayMobileSensitiveActions() }
                } label: {
                    Label("operations_replay_sensitive_actions", systemImage: "arrow.triangle.2.circlepath")
                }
            } header: {
                Text("operations_approval_section")
            }

            Section {
                LabeledContent("operations_sensitive_waiting_passkey", value: localizedString("operations_count_format", viewModel.mobileSensitiveActionSummary.pendingPasskeyCount))
                LabeledContent("operations_sensitive_ready_replay", value: localizedString("operations_count_format", viewModel.mobileSensitiveActionSummary.readyForReplayCount))
                LabeledContent("operations_sensitive_failed", value: localizedString("operations_count_format", viewModel.mobileSensitiveActionSummary.failedCount))
            } header: {
                Text("operations_sensitive_section")
            }

            Section {
                LabeledContent("operations_mail_unread", value: localizedString("operations_count_format", dashboard?.unreadMailCount ?? 0))
                if let mailThreads = dashboard?.mailThreads, mailThreads.isEmpty == false {
                    ForEach(mailThreads) { thread in
                        OperationsMailThreadRow(thread: thread) {
                            Task { await viewModel.markMailThreadRead(thread) }
                        }
                        .accessibilityIdentifier(FieldAccessibilityID.operationsMailThread(thread.id))
                    }
                } else {
                    Text("operations_mail_empty")
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("operations_mail_section")
            }

            Section {
                if let events = dashboard?.calendarEvents, events.isEmpty == false {
                    ForEach(events) { event in
                        OperationsCalendarEventRow(event: event)
                            .accessibilityIdentifier(FieldAccessibilityID.operationsCalendarEvent(event.id))
                    }
                } else {
                    Text("operations_calendar_empty")
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("operations_calendar_section")
            }

            Section {
                if let polls = dashboard?.polls, polls.isEmpty == false {
                    ForEach(polls) { poll in
                        OperationsPollRow(poll: poll) {
                            Task { await viewModel.votePoll(poll) }
                        }
                        .accessibilityIdentifier(FieldAccessibilityID.operationsPoll(poll.id))
                    }
                } else {
                    Text("operations_poll_empty")
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("operations_poll_section")
            }

            if let messageKey = viewModel.messageKey {
                Section {
                    Text(LocalizedStringKey(messageKey))
                }
            }
        }
        .accessibilityIdentifier(FieldAccessibilityID.operationsList)
        .navigationTitle(Text("operations_title"))
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    Task { await viewModel.refreshMobileOperations() }
                } label: {
                    Label("refresh", systemImage: "arrow.clockwise")
                }
                .accessibilityIdentifier(FieldAccessibilityID.operationsRefreshButton)
                Button {
                    Task { await viewModel.logout() }
                } label: {
                    Label("logout", systemImage: "rectangle.portrait.and.arrow.right")
                }
            }
        }
        .overlay {
            if viewModel.isLoading {
                ProgressView("loading")
            }
        }
        .task {
            if viewModel.mobileOperationsOverview == nil {
                await viewModel.refreshMobileOperations()
            }
        }
    }
}

struct OperationsMailThreadRow: View {
    let thread: MobileMailThreadRow
    let onMarkRead: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(thread.subject)
                    .font(.headline)
                Spacer()
                if thread.unreadCount > 0 {
                    FieldChip(key: "operations_unread_chip")
                }
            }
            Text(thread.lastMessageAt.formatted(date: .abbreviated, time: .shortened))
                .font(.footnote)
                .foregroundStyle(.secondary)
            HStack {
                Text(localizedString("operations_mail_unread_format", thread.unreadCount))
                if thread.hasAttachments { FieldChip(key: "operations_attachment_chip") }
                if thread.isFlagged { FieldChip(key: "operations_flagged_chip") }
            }
            .font(.caption)
            Button("operations_mark_read", action: onMarkRead)
                .disabled(thread.unreadCount == 0)
        }
        .padding(.vertical, 4)
    }
}

struct OperationsCalendarEventRow: View {
    let event: MobileCalendarEventRow

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(event.title)
                    .font(.headline)
                Spacer()
                FieldChip(key: operationsScopeKey(event.scopeType))
            }
            Text(event.description)
                .font(.subheadline)
            Text(localizedString("operations_calendar_time_format", event.startsAt.formatted(date: .abbreviated, time: .shortened), event.endsAt.formatted(date: .omitted, time: .shortened)))
                .font(.caption)
                .foregroundStyle(.secondary)
            if let objectType = event.objectType {
                Text(localizedString("operations_object_link_format", objectType))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if event.isCancelled {
                FieldChip(key: "operations_calendar_cancelled")
            }
        }
        .padding(.vertical, 4)
    }
}

struct OperationsPollRow: View {
    let poll: MobilePollRow
    let onVote: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(poll.title)
                    .font(.headline)
                Spacer()
                FieldChip(key: operationsPollStatusKey(poll.status))
            }
            Text(poll.question)
            HStack {
                FieldChip(key: operationsPollAnonymityKey(poll.anonymity))
                Text(localizedString("operations_poll_vote_count_format", poll.voteCount))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let option = poll.firstOptionLabel {
                Button {
                    onVote()
                } label: {
                    Label(localizedString("operations_poll_vote_option_format", option), systemImage: "checkmark.circle")
                }
                .disabled(poll.canVote == false)
            }
            if poll.hasSubmittedVote {
                Text("operations_poll_submitted")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}

private func operationsScopeKey(_ scope: Components.Schemas.CollaborationScopeType) -> String {
    switch scope {
    case .tenant: "operations_scope_tenant"
    case .org: "operations_scope_org"
    case .department: "operations_scope_department"
    case .team: "operations_scope_team"
    case .personal: "operations_scope_personal"
    }
}

private func operationsPollStatusKey(_ status: Components.Schemas.PollStatus) -> String {
    switch status {
    case .draft: "operations_poll_status_draft"
    case .open: "operations_poll_status_open"
    case .closed: "operations_poll_status_closed"
    case .archived: "operations_poll_status_archived"
    }
}

private func operationsPollAnonymityKey(_ anonymity: Components.Schemas.PollAnonymity) -> String {
    switch anonymity {
    case .named: "operations_poll_named"
    case .anonymous: "operations_poll_anonymous"
    }
}

struct LoginView: View {
    @ObservedObject var viewModel: FieldViewModel

    var body: some View {
        Form {
            Section {
                TextField(String(localized: "user_id"), text: $viewModel.userID)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
                    .accessibilityIdentifier(FieldAccessibilityID.loginUserIDField)
                Button {
                    Task { await viewModel.login() }
                } label: {
                    Label("login_button", systemImage: "person.badge.key")
                }
                .disabled(viewModel.isLoading)
                .accessibilityIdentifier(FieldAccessibilityID.loginButton)
            } header: {
                Text("login_title")
            }

            if let messageKey = viewModel.messageKey {
                Text(LocalizedStringKey(messageKey))
                    .foregroundStyle(.red)
                    .accessibilityIdentifier(FieldAccessibilityID.loginErrorMessage)
            }
        }
    }
}

struct TodayListView: View {
    @ObservedObject var viewModel: FieldViewModel

    var body: some View {
        List {
            LocationConsentSection(viewModel: viewModel)
            if let messageKey = viewModel.messageKey {
                Text(LocalizedStringKey(messageKey))
            }
            if viewModel.today.isEmpty {
                Text("empty_today")
                    .accessibilityIdentifier(FieldAccessibilityID.todayEmpty)
            }
            ForEach(viewModel.today) { workOrder in
                Button {
                    viewModel.select(workOrder)
                } label: {
                    WorkOrderRow(workOrder: workOrder)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier(FieldAccessibilityID.workOrderRow(workOrder.id))
            }
        }
        .accessibilityIdentifier(FieldAccessibilityID.todayList)
        .navigationTitle(Text("today_title"))
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    Task { await viewModel.refreshToday() }
                } label: {
                    Label("refresh", systemImage: "arrow.clockwise")
                }
                .accessibilityIdentifier(FieldAccessibilityID.todayRefreshButton)
                Button {
                    Task { await viewModel.logout() }
                } label: {
                    Label("logout", systemImage: "rectangle.portrait.and.arrow.right")
                }
                .accessibilityIdentifier(FieldAccessibilityID.todayLogoutButton)
            }
        }
        .overlay {
            if viewModel.isLoading {
                ProgressView("loading")
                    .accessibilityIdentifier(FieldAccessibilityID.todayLoading)
            }
        }
        .sheet(item: $viewModel.selectedWorkOrder) { _ in
            WorkOrderDetailView(viewModel: viewModel)
        }
    }
}

struct MessengerTabView: View {
    @ObservedObject var viewModel: FieldViewModel

    var body: some View {
        List {
            Section {
                HStack {
                    TextField(String(localized: "messenger_search"), text: $viewModel.messengerSearchQuery)
                        .accessibilityIdentifier(FieldAccessibilityID.messengerSearchField)
                    Button {
                        Task { await viewModel.searchMessengerMessages() }
                    } label: {
                        Label("messenger_search_button", systemImage: "magnifyingglass")
                    }
                    .accessibilityIdentifier(FieldAccessibilityID.messengerSearchButton)
                }
                if viewModel.messengerState.searchResults.isEmpty == false {
                    ForEach(viewModel.messengerState.searchResults) { message in
                        MessengerMessageRow(message: message, currentUserID: viewModel.currentUserID)
                            .accessibilityIdentifier(FieldAccessibilityID.messengerMessageRow(message.id))
                    }
                } else if viewModel.messengerHasSearched {
                    Text("messenger_search_no_results")
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier(FieldAccessibilityID.messengerSearchNoResults)
                }
            }

            Section {
                if viewModel.messengerState.threads.isEmpty {
                    Text("messenger_empty_threads")
                        .accessibilityIdentifier(FieldAccessibilityID.messengerEmptyThreads)
                }
                ForEach(viewModel.messengerState.threads) { thread in
                    Button {
                        Task { await viewModel.selectMessengerThread(thread) }
                    } label: {
                        MessengerThreadRow(
                            thread: thread,
                            isSelected: viewModel.messengerState.selectedThreadID == thread.id
                        )
                    }
                    .accessibilityIdentifier(FieldAccessibilityID.messengerThreadRow(thread.id))
                }
            } header: {
                Text("messenger_threads")
            }

            Section {
                if let selectedThreadID = viewModel.messengerState.selectedThreadID {
                    let messages = viewModel.messengerState.messagesByThread[selectedThreadID] ?? []
                    if viewModel.messengerState.nextCursorByThread[selectedThreadID] != nil {
                        Button {
                            Task { await viewModel.loadOlderMessengerMessages() }
                        } label: {
                            Label("messenger_load_older", systemImage: "arrow.up.circle")
                        }
                    }
                    if messages.isEmpty {
                        Text("messenger_empty_messages")
                    }
                    ForEach(messages) { message in
                        MessengerMessageRow(message: message, currentUserID: viewModel.currentUserID)
                            .accessibilityIdentifier(FieldAccessibilityID.messengerMessageRow(message.id))
                    }
                    TextField(String(localized: "messenger_composer"), text: $viewModel.messengerDraft, axis: .vertical)
                        .lineLimit(2...5)
                        .accessibilityIdentifier(FieldAccessibilityID.messengerComposerField)
                    Button {
                        Task { await viewModel.sendMessengerMessage() }
                    } label: {
                        Label("messenger_send", systemImage: "paperplane.fill")
                    }
                    .accessibilityIdentifier(FieldAccessibilityID.messengerSendButton)
                } else {
                    Text("messenger_select_thread")
                        .accessibilityIdentifier(FieldAccessibilityID.messengerSelectThreadPrompt)
                }
            } header: {
                Text("messenger_messages")
            }

            if let messageKey = viewModel.messageKey {
                Text(LocalizedStringKey(messageKey))
            }
        }
        .navigationTitle(Text("messenger_title"))
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    Task { await viewModel.refreshMessenger() }
                } label: {
                    Label("refresh", systemImage: "arrow.clockwise")
                }
                .accessibilityIdentifier(FieldAccessibilityID.messengerRefreshButton)
                Button {
                    Task { await viewModel.logout() }
                } label: {
                    Label("logout", systemImage: "rectangle.portrait.and.arrow.right")
                }
                .accessibilityIdentifier(FieldAccessibilityID.messengerLogoutButton)
            }
        }
        .overlay {
            if viewModel.isLoading {
                ProgressView("loading")
            }
        }
        .task {
            if viewModel.messengerState.threads.isEmpty {
                await viewModel.refreshMessenger()
            }
        }
    }
}

struct MessengerThreadRow: View {
    let thread: MessengerThread
    let isSelected: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(messengerThreadDisplayTitle(thread))
                    .font(.headline)
                Spacer()
                FieldChip(key: thread.kind.fieldLabelKey)
            }
            Text(localizedString("messenger_member_count_format", thread.memberCount))
                .font(.footnote)
                .foregroundStyle(.secondary)
            if isSelected {
                Text("messenger_selected")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private func messengerThreadDisplayTitle(_ thread: MessengerThread) -> String {
    if let title = thread.trimmedTitle {
        return title
    }

    switch thread.kind {
    case .workOrder:
        if let identifier = thread.friendlyWorkOrderIdentifier {
            return localizedString("messenger_thread_work_order_format", identifier)
        }
        return localizedString("messenger_thread_work_order")
    case .team:
        return localizedString("messenger_thread_team")
    case .dm:
        return localizedString("messenger_thread_dm")
    case .group:
        return localizedString("messenger_thread_group")
    }
}

private extension MessengerThread {
    var trimmedTitle: String? {
        guard let title else { return nil }
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    var friendlyWorkOrderIdentifier: String? {
        guard let workOrderID else { return nil }
        let trimmed = workOrderID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.isEmpty == false else { return nil }
        return UUID(uuidString: trimmed) == nil ? trimmed : nil
    }
}

struct MessengerMessageRow: View {
    let message: MessengerMessage
    let currentUserID: Components.Schemas.Uuid?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if currentUserID == message.senderID, message.readTargetCount > 0 {
                Text(localizedString("messenger_read_progress_format", message.readCount, message.readTargetCount))
                    .font(.caption)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(.thinMaterial, in: Capsule())
            }
            Text(message.body)
                .font(.body)
            HStack {
                Text(message.sentAt.formatted(date: .abbreviated, time: .shortened))
                if message.attachmentEvidenceIDs.isEmpty == false {
                    FieldChip(key: "messenger_attachment")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }
}

struct WorkOrderRow: View {
    let workOrder: TechnicianWorkOrder

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(workOrder.requestNo)
                    .font(.headline)
                Spacer()
                FieldChip(key: workOrder.priority.fieldLabelKey)
            }
            Text(localizedString("site_format", workOrder.customerName, workOrder.siteName))
                .font(.subheadline)
            Text(localizedString("equipment_format", workOrder.managementNo, workOrder.modelName))
                .font(.footnote)
                .foregroundStyle(.secondary)
            HStack {
                FieldChip(key: workOrder.status.fieldLabelKey)
                FieldChip(key: workOrder.syncState.fieldLabelKey)
            }
        }
        .padding(.vertical, 6)
    }
}

struct WorkOrderDetailView: View {
    @ObservedObject var viewModel: FieldViewModel

    var body: some View {
        NavigationStack {
            if let workOrder = viewModel.selectedWorkOrder {
                Form {
                    LocationConsentSection(viewModel: viewModel)

                    Section {
                        LabeledContent("request_no", value: workOrder.requestNo)
                        LabeledContent(
                            "equipment",
                            value: localizedString("equipment_format", workOrder.managementNo, workOrder.modelName)
                        )
                        LabeledContent("site", value: workOrder.siteName)
                        if let symptom = workOrder.symptom {
                            LabeledContent("symptom", value: symptom)
                        }
                        if let targetDueAt = workOrder.targetDueAt {
                            LabeledContent(
                                "target_due",
                                value: targetDueAt.formatted(date: .abbreviated, time: .shortened)
                            )
                        }
                        HStack {
                            FieldChip(key: workOrder.priority.fieldLabelKey)
                            FieldChip(key: workOrder.status.fieldLabelKey)
                                .accessibilityIdentifier(FieldAccessibilityID.detailStatus)
                            FieldChip(key: workOrder.syncState.fieldLabelKey)
                        }
                    }

                    Section {
                        Button {
                            Task { await viewModel.startSelectedWork() }
                        } label: {
                            Label("detail_start_work", systemImage: "play.fill")
                        }
                        .accessibilityIdentifier(FieldAccessibilityID.detailStartWorkButton)
                    }

                    Section {
                        Picker("result_type", selection: $viewModel.resultType) {
                            ForEach(reportableResults, id: \.self) { result in
                                Text(LocalizedStringKey(result.fieldLabelKey)).tag(result)
                            }
                        }
                        .accessibilityIdentifier(FieldAccessibilityID.detailResultTypePicker)
                        TextField(String(localized: "report_diagnosis"), text: $viewModel.diagnosis, axis: .vertical)
                            .lineLimit(3...6)
                            .accessibilityIdentifier(FieldAccessibilityID.detailDiagnosisField)
                        TextField(String(localized: "report_action"), text: $viewModel.actionTaken, axis: .vertical)
                            .lineLimit(3...6)
                            .accessibilityIdentifier(FieldAccessibilityID.detailActionTakenField)
                        Button {
                            Task { await viewModel.submitReport() }
                        } label: {
                            Label("submit_report", systemImage: "paperplane.fill")
                        }
                        .accessibilityIdentifier(FieldAccessibilityID.detailSubmitReportButton)
                    }

                    Section {
                        Button {
                            viewModel.isCameraPresented = true
                        } label: {
                            Label("capture_evidence", systemImage: "camera.fill")
                        }
                        .accessibilityIdentifier(FieldAccessibilityID.detailCaptureEvidenceButton)
                    }

                    if let messageKey = viewModel.messageKey {
                        Text(LocalizedStringKey(messageKey))
                            .accessibilityIdentifier(FieldAccessibilityID.detailMessage)
                    }
                }
                .accessibilityIdentifier(FieldAccessibilityID.detailView)
                .navigationTitle(Text(workOrder.requestNo))
                .toolbar {
                    Button {
                        viewModel.closeDetail()
                    } label: {
                        Label("back", systemImage: "xmark")
                    }
                    .accessibilityIdentifier(FieldAccessibilityID.detailBackButton)
                }
            }
        }
    }

    private var reportableResults: [Components.Schemas.WorkResultType] {
        [.completed, .temporaryAction, .incomplete, .revisitRequired]
    }
}

struct LocationConsentSection: View {
    @ObservedObject var viewModel: FieldViewModel

    private var state: Components.Schemas.LocationConsentState {
        viewModel.locationConsent?.state ?? .noRecord
    }

    var body: some View {
        Section {
            LabeledContent(
                "location_consent_state",
                value: localizedString(locationConsentStateKey(state))
            )
            LabeledContent(
                "location_consent_collection",
                value: localizedString(viewModel.locationConsent?.mayCollect == true ? "yes" : "no")
            )
            Button {
                Task { await viewModel.grantLocationConsent() }
            } label: {
                Label {
                    Text(LocalizedStringKey(state == .withdrawn ? "location_consent_regain" : "location_consent_grant"))
                } icon: {
                    Image(systemName: "checkmark.shield")
                }
            }
            .disabled(viewModel.isLoading || state == .granted)
            .accessibilityIdentifier(FieldAccessibilityID.locationConsentGrantButton)

            Button {
                Task { await viewModel.suspendLocationConsent() }
            } label: {
                Label("location_consent_suspend", systemImage: "location.slash")
            }
            .disabled(viewModel.isLoading || state != .granted)
            .accessibilityIdentifier(FieldAccessibilityID.locationConsentSuspendButton)

            Button {
                Task { await viewModel.resumeLocationConsent() }
            } label: {
                Label("location_consent_resume", systemImage: "location")
            }
            .disabled(viewModel.isLoading || state != .suspended)
            .accessibilityIdentifier(FieldAccessibilityID.locationConsentResumeButton)

            Button(role: .destructive) {
                Task { await viewModel.withdrawLocationConsent() }
            } label: {
                Label("location_consent_withdraw", systemImage: "trash")
            }
            .disabled(viewModel.isLoading || (state != .granted && state != .suspended))
            .accessibilityIdentifier(FieldAccessibilityID.locationConsentWithdrawButton)
        } header: {
            Text("location_consent_title")
        }
    }
}

struct FieldChip: View {
    let key: String

    var body: some View {
        Text(LocalizedStringKey(key))
            .font(.caption)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(.thinMaterial, in: Capsule())
    }
}

private func localizedString(_ key: String, _ arguments: CVarArg...) -> String {
    let format = NSLocalizedString(key, bundle: fieldLocalizationBundle, comment: "")
    return String(format: format, locale: Locale.current, arguments: arguments)
}

private var fieldLocalizationBundle: Bundle {
    #if SWIFT_PACKAGE
    .module
    #else
    .main
    #endif
}

private func locationConsentStateKey(_ state: Components.Schemas.LocationConsentState) -> String {
    switch state {
    case .noRecord:
        return "location_consent_state_no_record"
    case .granted:
        return "location_consent_state_granted"
    case .suspended:
        return "location_consent_state_suspended"
    case .withdrawn:
        return "location_consent_state_withdrawn"
    }
}
