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
                LabeledContent("work_hub_today_count", value: String(summary.todayWorkCount))
                LabeledContent("work_hub_urgent_count", value: String(summary.urgentWorkCount))
                LabeledContent("work_hub_target_due_count", value: String(summary.targetDueWorkCount))
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
                LabeledContent("work_hub_approval_count", value: String(summary.approvalRelatedCount))
                LabeledContent("work_hub_pending_sync", value: String(summary.pendingSyncCount))
                Label("work_hub_passkey_required", systemImage: "person.badge.key")
                Text("work_hub_sensitive_note")
            } header: {
                Text("work_hub_sensitive_section")
            }

            Section {
                LabeledContent("work_hub_messenger_count", value: String(summary.messengerThreadCount))
                Text("work_hub_notifications_note")
                Text("work_hub_company_mail_note")
                Text("work_hub_shared_calendar_note")
                Text("work_hub_polls_note")
            } header: {
                Text("work_hub_collaboration_section")
            } footer: {
                Text("work_hub_staged_footer")
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
                        MessengerMessageRow(message: message)
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
                        MessengerMessageRow(message: message)
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
                Text(thread.displayTitle)
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

struct MessengerMessageRow: View {
    let message: MessengerMessage

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
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
