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
            MessengerTabView(viewModel: viewModel)
                .tabItem {
                    Label("messenger_title", systemImage: "message.fill")
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
                    .textContentType(.username)
                Button {
                    Task { await viewModel.login() }
                } label: {
                    Label("login_button", systemImage: "person.badge.key")
                }
                .disabled(viewModel.isLoading)
            } header: {
                Text("login_title")
            }

            if let messageKey = viewModel.messageKey {
                Text(LocalizedStringKey(messageKey))
                    .foregroundStyle(.red)
            }
        }
    }
}

struct TodayListView: View {
    @ObservedObject var viewModel: FieldViewModel

    var body: some View {
        List {
            if viewModel.today.isEmpty {
                Text("empty_today")
            }
            ForEach(viewModel.today) { workOrder in
                Button {
                    viewModel.select(workOrder)
                } label: {
                    WorkOrderRow(workOrder: workOrder)
                }
                .buttonStyle(.plain)
            }
        }
        .navigationTitle(Text("today_title"))
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    Task { await viewModel.refreshToday() }
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
        .overlay {
            if viewModel.isLoading {
                ProgressView("loading")
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
                    Button {
                        Task { await viewModel.searchMessengerMessages() }
                    } label: {
                        Label("messenger_search_button", systemImage: "magnifyingglass")
                    }
                }
                if viewModel.messengerState.searchResults.isEmpty == false {
                    ForEach(viewModel.messengerState.searchResults) { message in
                        MessengerMessageRow(message: message)
                    }
                }
            }

            Section {
                if viewModel.messengerState.threads.isEmpty {
                    Text("messenger_empty_threads")
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
                    Button {
                        Task { await viewModel.sendMessengerMessage() }
                    } label: {
                        Label("messenger_send", systemImage: "paperplane.fill")
                    }
                } else {
                    Text("messenger_select_thread")
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
                Text(message.sentAt.formatted(date: .omitted, time: .shortened))
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
            Text(workOrder.customerName)
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
                    }

                    Section {
                        Picker("result_type", selection: $viewModel.resultType) {
                            ForEach(reportableResults, id: \.self) { result in
                                Text(LocalizedStringKey(result.fieldLabelKey)).tag(result)
                            }
                        }
                        TextField(String(localized: "report_diagnosis"), text: $viewModel.diagnosis, axis: .vertical)
                            .lineLimit(3...6)
                        TextField(String(localized: "report_action"), text: $viewModel.actionTaken, axis: .vertical)
                            .lineLimit(3...6)
                        Button {
                            Task { await viewModel.submitReport() }
                        } label: {
                            Label("submit_report", systemImage: "paperplane.fill")
                        }
                    }

                    Section {
                        Button {
                            viewModel.isCameraPresented = true
                        } label: {
                            Label("capture_evidence", systemImage: "camera.fill")
                        }
                    }

                    if let messageKey = viewModel.messageKey {
                        Text(LocalizedStringKey(messageKey))
                    }
                }
                .navigationTitle(Text(workOrder.requestNo))
                .toolbar {
                    Button {
                        viewModel.closeDetail()
                    } label: {
                        Label("back", systemImage: "xmark")
                    }
                }
            }
        }
    }

    private var reportableResults: [Components.Schemas.WorkResultType] {
        [.completed, .temporaryAction, .incomplete, .revisitRequired]
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
    let format = NSLocalizedString(key, bundle: .module, comment: "")
    return String(format: format, locale: Locale.current, arguments: arguments)
}
