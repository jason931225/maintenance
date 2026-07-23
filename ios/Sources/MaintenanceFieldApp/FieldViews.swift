import Foundation
import MaintenanceAPIClient
import MaintenanceFieldCore
import SwiftUI

#if os(iOS)
import UIKit
#endif

struct FieldRootView: View {
    @StateObject var viewModel: FieldViewModel

    var body: some View {
        Group {
            if viewModel.isAuthenticated {
                FieldAuthenticatedTabs(viewModel: viewModel)
            } else {
                NavigationStack {
                    LoginView(viewModel: viewModel)
                        .navigationTitle(Text("app_name"))
                        .inlineNavigationTitle()
                }
            }
        }
        .task {
            viewModel.restore()
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
            UnobscuredTabContent {
                NavigationStack {
                    TodayListView(viewModel: viewModel)
                }
            }
                .tabItem {
                    Label("today_title", systemImage: "list.bullet")
                }
            UnobscuredTabContent {
                NavigationStack {
                    WorkHubTabView(viewModel: viewModel)
                        .accessibilityIdentifier(FieldAccessibilityID.workHubTab)
                }
            }
                .tabItem {
                    Label("work_hub_title", systemImage: "square.grid.2x2")
                }
            UnobscuredTabContent {
                NavigationStack {
                    MessengerTabView(viewModel: viewModel)
                        .accessibilityIdentifier(FieldAccessibilityID.messengerTab)
                }
            }
                .tabItem {
                    Label("messenger_title", systemImage: "message.fill")
                }
            UnobscuredTabContent {
                NavigationStack {
                    OperationsTabView(viewModel: viewModel)
                        .accessibilityIdentifier(FieldAccessibilityID.operationsTab)
                }
            }
                .tabItem {
                    Label("operations_title", systemImage: "tray.full")
                }
        }
        .accessibilityIdentifier(FieldAccessibilityID.authenticatedTabs)
    }
}

private struct UnobscuredTabContent<Content: View>: View {
    let content: Content
    @State private var contentInsets = TabBarContentInsets.zero

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    @ViewBuilder
    var body: some View {
        #if os(iOS)
        if #available(iOS 26.0, *) {
            // Keep the UIKit probe in the outer tab-content shell.  The content it
            // measures is intentionally a sibling of the padded SwiftUI tree so a
            // newly reported inset cannot change the probe's own coordinate space.
            ZStack {
                TabBarContentLayoutGuideProbe { measuredInsets in
                    guard contentInsets.isApproximatelyEqual(to: measuredInsets) == false else {
                        return
                    }
                    contentInsets = measuredInsets
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .allowsHitTesting(false)
                .accessibilityHidden(true)

                content
                    .padding(contentInsets.edgeInsets)
            }
        } else {
            content
        }
        #else
        content
        #endif
    }
}

private struct TabBarContentInsets: Equatable {
    static let zero = TabBarContentInsets(top: 0, leading: 0, bottom: 0, trailing: 0)

    let top: CGFloat
    let leading: CGFloat
    let bottom: CGFloat
    let trailing: CGFloat

    var edgeInsets: EdgeInsets {
        EdgeInsets(top: top, leading: leading, bottom: bottom, trailing: trailing)
    }

    func isApproximatelyEqual(to other: TabBarContentInsets) -> Bool {
        abs(top - other.top) < 0.5
            && abs(leading - other.leading) < 0.5
            && abs(bottom - other.bottom) < 0.5
            && abs(trailing - other.trailing) < 0.5
    }
}

#if os(iOS)
@available(iOS 26.0, *)
@MainActor
private struct TabBarContentLayoutGuideProbe: UIViewControllerRepresentable {
    let onInsetsChange: @MainActor (TabBarContentInsets) -> Void

    func makeUIViewController(context: Context) -> TabBarContentLayoutGuideProbeController {
        TabBarContentLayoutGuideProbeController(onInsetsChange: onInsetsChange)
    }

    func updateUIViewController(
        _ uiViewController: TabBarContentLayoutGuideProbeController,
        context: Context
    ) {
        uiViewController.onInsetsChange = onInsetsChange
        uiViewController.requestMeasurement()
    }

    static func dismantleUIViewController(
        _ uiViewController: TabBarContentLayoutGuideProbeController,
        coordinator: ()
    ) {
        uiViewController.invalidate()
    }
}

@available(iOS 26.0, *)
@MainActor
private final class TabBarContentLayoutGuideSensor: UIView {
    var onLayout: (@MainActor () -> Void)?

    override func layoutSubviews() {
        super.layoutSubviews()
        onLayout?()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        onLayout?()
    }
}

@available(iOS 26.0, *)
@MainActor
private final class TabBarContentLayoutGuideProbeController: UIViewController {
    var onInsetsChange: (@MainActor (TabBarContentInsets) -> Void)?
    private var lastReportedInsets = TabBarContentInsets.zero
    private weak var observedTabBarController: UITabBarController?
    private var contentLayoutSensor: TabBarContentLayoutGuideSensor?
    private var pendingMeasurementTask: Task<Void, Never>?

    init(onInsetsChange: @escaping @MainActor (TabBarContentInsets) -> Void) {
        self.onInsetsChange = onInsetsChange
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func loadView() {
        let probeView = UIView()
        probeView.backgroundColor = .clear
        probeView.isUserInteractionEnabled = false
        probeView.isAccessibilityElement = false
        view = probeView
    }

    override func viewIsAppearing(_ animated: Bool) {
        super.viewIsAppearing(animated)
        requestMeasurement()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        requestMeasurement()
    }

    override func didMove(toParent parent: UIViewController?) {
        super.didMove(toParent: parent)
        if parent == nil {
            invalidate()
        } else {
            requestMeasurement()
        }
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        requestMeasurement()
    }

    override func viewWillTransition(
        to size: CGSize,
        with coordinator: any UIViewControllerTransitionCoordinator
    ) {
        super.viewWillTransition(to: size, with: coordinator)
        coordinator.animate(alongsideTransition: nil) { [weak self] _ in
            self?.requestMeasurement()
        }
    }

    func requestMeasurement() {
        guard pendingMeasurementTask == nil else { return }

        pendingMeasurementTask = Task { @MainActor [weak self] in
            // Publishing in the same layout pass would feed the SwiftUI padding
            // update back into UIKit layout.  One cooperative turn breaks that
            // re-entrant loop while preserving every lifecycle trigger above.
            await Task.yield()
            guard let self, Task.isCancelled == false else { return }
            self.pendingMeasurementTask = nil
            self.reportContentInsetsIfAvailable()
        }
    }

    private func reportContentInsetsIfAvailable() {
        guard
            let window = viewIfLoaded?.window,
            let tabBarController,
            tabBarController.view.window === window
        else {
            removeContentLayoutSensor()
            return
        }

        tabBarController.view.layoutIfNeeded()
        guard let sensor = installContentLayoutSensorIfNeeded(in: tabBarController) else { return }
        tabBarController.view.layoutIfNeeded()

        let probeBounds = view.bounds
        guard
            probeBounds.isEmpty == false,
            let sensorSuperview = sensor.superview
        else {
            return
        }

        let sensorFrame = sensorSuperview.convert(sensor.frame, to: view)
        guard sensorFrame.isEmpty == false else { return }

        let left = max(sensorFrame.minX - probeBounds.minX, 0)
        let right = max(probeBounds.maxX - sensorFrame.maxX, 0)
        let layoutDirection = view.effectiveUserInterfaceLayoutDirection

        let measuredInsets = TabBarContentInsets(
            top: max(sensorFrame.minY - probeBounds.minY, 0),
            leading: layoutDirection == .rightToLeft ? right : left,
            bottom: max(probeBounds.maxY - sensorFrame.maxY, 0),
            trailing: layoutDirection == .rightToLeft ? left : right
        )
        guard lastReportedInsets.isApproximatelyEqual(to: measuredInsets) == false else { return }
        lastReportedInsets = measuredInsets
        onInsetsChange?(measuredInsets)
    }

    private func installContentLayoutSensorIfNeeded(
        in tabBarController: UITabBarController
    ) -> TabBarContentLayoutGuideSensor? {
        if observedTabBarController === tabBarController, let contentLayoutSensor {
            return contentLayoutSensor
        }

        removeContentLayoutSensor()

        let sensor = TabBarContentLayoutGuideSensor()
        sensor.translatesAutoresizingMaskIntoConstraints = false
        sensor.backgroundColor = .clear
        sensor.isUserInteractionEnabled = false
        sensor.isAccessibilityElement = false
        sensor.onLayout = { [weak self] in
            self?.requestMeasurement()
        }
        tabBarController.view.addSubview(sensor)
        NSLayoutConstraint.activate([
            sensor.topAnchor.constraint(equalTo: tabBarController.contentLayoutGuide.topAnchor),
            sensor.leadingAnchor.constraint(equalTo: tabBarController.contentLayoutGuide.leadingAnchor),
            sensor.bottomAnchor.constraint(equalTo: tabBarController.contentLayoutGuide.bottomAnchor),
            sensor.trailingAnchor.constraint(equalTo: tabBarController.contentLayoutGuide.trailingAnchor),
        ])
        observedTabBarController = tabBarController
        contentLayoutSensor = sensor
        return sensor
    }

    private func removeContentLayoutSensor() {
        contentLayoutSensor?.onLayout = nil
        contentLayoutSensor?.removeFromSuperview()
        contentLayoutSensor = nil
        observedTabBarController = nil
    }

    func invalidate() {
        pendingMeasurementTask?.cancel()
        pendingMeasurementTask = nil
        removeContentLayoutSensor()
        onInsetsChange = nil
    }

    deinit {
        pendingMeasurementTask?.cancel()
    }
}
#endif


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
                    Text("login_button")
                        .font(.body)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .tint(.primary)
                .disabled(viewModel.isLoading)
                .accessibilityIdentifier(FieldAccessibilityID.loginButton)
            } header: {
                Text("login_title")
                    .foregroundStyle(.primary)
            }
            .headerProminence(.increased)

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
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var isLocationConsentPresented = false

    var body: some View {
        List {
            if dynamicTypeSize.isAccessibilitySize == false {
                LocationConsentSection(viewModel: viewModel)
            }
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
                if dynamicTypeSize.isAccessibilitySize {
                    Button {
                        isLocationConsentPresented = true
                    } label: {
                        Label("location_consent_title", systemImage: "location.circle")
                    }
                    .accessibilityIdentifier(FieldAccessibilityID.todayLocationConsentButton)
                }
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
        .sheet(isPresented: $isLocationConsentPresented) {
            NavigationStack {
                Form {
                    LocationConsentSection(viewModel: viewModel)
                }
                .accessibilityIdentifier(FieldAccessibilityID.todayLocationConsentSheet)
                .navigationTitle(Text("location_consent_title"))
                .inlineNavigationTitle()
                .toolbar {
                    Button {
                        isLocationConsentPresented = false
                    } label: {
                        Label("close", systemImage: "xmark")
                    }
                    .accessibilityIdentifier(FieldAccessibilityID.todayLocationConsentCloseButton)
                }
            }
        }
        .workOrderDetailPresentation(item: $viewModel.selectedWorkOrder) { _ in
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
                    ZStack(alignment: .leading) {
                        if viewModel.messengerSearchQuery.isEmpty {
                            Text("messenger_search")
                                .foregroundStyle(.primary)
                                .accessibilityHidden(true)
                        }
                        TextField("", text: $viewModel.messengerSearchQuery, axis: .vertical)
                            .accessibilityLabel(Text("messenger_search"))
                            .accessibilityIdentifier(FieldAccessibilityID.messengerSearchField)
                    }
                        .lineLimit(1...2)
                        .layoutPriority(1)
                    Button {
                        Task { await viewModel.searchMessengerMessages() }
                    } label: {
                        Label("messenger_search_button", systemImage: "magnifyingglass")
                            .labelStyle(.iconOnly)
                            .foregroundStyle(.primary)
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel(Text("messenger_search_button"))
                    .accessibilityIdentifier(FieldAccessibilityID.messengerSearchButton)
                    .buttonStyle(.plain)
                    .tint(.primary)
                }
                if viewModel.messengerState.searchResults.isEmpty == false {
                    ForEach(viewModel.messengerState.searchResults) { message in
                        MessengerMessageRow(
                            message: message,
                            currentUserID: viewModel.currentUserID,
                            accessibilityIdentifier: FieldAccessibilityID.messengerSearchResultRow(message.id)
                        )
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
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier(FieldAccessibilityID.messengerThreadRow(thread.id))
                }
            } header: {
                Text("messenger_threads")
                    .foregroundStyle(.primary)
            }
            .headerProminence(.increased)

            Section {
                Text("messenger_messages")
                    .font(.headline)
                    .fixedSize(horizontal: false, vertical: true)
                    .foregroundStyle(.primary)
                    .accessibilityAddTraits(.isHeader)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)

                if let selectedThreadID = viewModel.messengerState.selectedThreadID {
                    let messages = viewModel.messengerState.messagesByThread[selectedThreadID] ?? []
                    // Dictionary lookup returns a nested optional because the
                    // stored cursor is itself optional. A present key with a
                    // nil cursor means there is no older page to load.
                    if let _ = viewModel.messengerState.nextCursorByThread[selectedThreadID] ?? nil {
                        Button {
                            Task { await viewModel.loadOlderMessengerMessages() }
                        } label: {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Image(systemName: "arrow.up.circle")
                                    .accessibilityHidden(true)
                                Text("messenger_load_older")
                                    .font(.body)
                                    .multilineTextAlignment(.leading)
                            }
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        }
                    }
                    if messages.isEmpty {
                        Text("messenger_empty_messages")
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    ForEach(messages) { message in
                        MessengerMessageRow(
                            message: message,
                            currentUserID: viewModel.currentUserID,
                            accessibilityIdentifier: FieldAccessibilityID.messengerMessageRow(message.id)
                        )
                    }
                    HStack(alignment: .bottom) {
                        TextField(String(localized: "messenger_composer"), text: $viewModel.messengerDraft, axis: .vertical)
                            .lineLimit(2...5)
                            .layoutPriority(1)
                            .accessibilityIdentifier(FieldAccessibilityID.messengerComposerField)
                        Button {
                            Task { await viewModel.sendMessengerMessage() }
                        } label: {
                            Label("messenger_send", systemImage: "paperplane.fill")
                                .labelStyle(.iconOnly)
                                .frame(minWidth: 44, minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .accessibilityLabel(Text("messenger_send"))
                        .accessibilityIdentifier(FieldAccessibilityID.messengerSendButton)
                    }
                } else {
                    Text("messenger_select_thread")
                        .accessibilityIdentifier(FieldAccessibilityID.messengerSelectThreadPrompt)
                }
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
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                FieldChip(key: thread.kind.fieldLabelKey)
            }
            Text(localizedString("messenger_member_count_format", thread.memberCount))
                .font(.footnote)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
            if isSelected {
                Text("messenger_selected")
                    .font(.caption)
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
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
    let accessibilityIdentifier: String
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if currentUserID == message.senderID, message.readTargetCount > 0 {
                Text(localizedString("messenger_read_progress_format", message.readCount, message.readTargetCount))
                    .font(.caption)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(.thinMaterial, in: Capsule())
            }
            messageContent
        }
    }

    @ViewBuilder
    private var messageContent: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 6) {
                bodyText
                timestampAndAttachment
            }
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                bodyText
                Spacer(minLength: 8)
                timestampAndAttachment
            }
        }
    }

    private var bodyText: some View {
        Text(message.body)
            .font(.body)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier(accessibilityIdentifier)
    }

    private var timestampAndAttachment: some View {
        HStack(spacing: 6) {
            Text(message.sentAt.formatted(date: .abbreviated, time: .shortened))
                .font(.caption)
                .accessibilityIdentifier(FieldAccessibilityID.messengerMessageTimestamp(message.id))
            if message.attachmentEvidenceIDs.isEmpty == false {
                FieldChip(key: "messenger_attachment")
            }
        }
        .foregroundStyle(.primary)
        .fixedSize(horizontal: false, vertical: true)
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
                .foregroundStyle(.primary)
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
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        NavigationStack {
            if let workOrder = viewModel.selectedWorkOrder {
                Form {
                    LocationConsentSection(viewModel: viewModel)

                    Section {
                        metadataRow("request_no", value: workOrder.requestNo)
                        metadataRow(
                            "equipment",
                            value: localizedString("equipment_format", workOrder.managementNo, workOrder.modelName)
                        )
                        metadataRow("site", value: workOrder.siteName)
                        if let symptom = workOrder.symptom {
                            metadataRow(
                                "symptom",
                                value: symptom,
                                labelIdentifier: FieldAccessibilityID.detailSymptomLabel,
                                valueIdentifier: FieldAccessibilityID.detailSymptomValue
                            )
                        }
                        if let targetDueAt = workOrder.targetDueAt {
                            metadataRow(
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
                .scrollDismissesKeyboard(.immediately)
                .accessibilityIdentifier(FieldAccessibilityID.detailView)
                .navigationTitle(Text("detail_title"))
                .inlineNavigationTitle()
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

    @ViewBuilder
    private func metadataRow(
        _ labelKey: LocalizedStringKey,
        value: String,
        labelIdentifier: String? = nil,
        valueIdentifier: String? = nil
    ) -> some View {
        let usesVerticalLayout = dynamicTypeSize.isAccessibilitySize
        let layout = usesVerticalLayout
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))
        layout {
            metadataText(labelKey, identifier: labelIdentifier)
            if usesVerticalLayout == false {
                Spacer(minLength: 12)
            }
            metadataValueText(value, alignLeading: usesVerticalLayout, identifier: valueIdentifier)
        }
    }

    @ViewBuilder
    private func metadataText(_ key: LocalizedStringKey, identifier: String?) -> some View {
        let text = Text(key)
            .font(.body)
            .foregroundStyle(.primary)
            .fixedSize(horizontal: false, vertical: true)
        if let identifier {
            text.accessibilityIdentifier(identifier)
        } else {
            text
        }
    }

    @ViewBuilder
    private func metadataValueText(
        _ value: String,
        alignLeading: Bool,
        identifier: String?
    ) -> some View {
        let text = Text(value)
            .font(.body)
            .foregroundStyle(.primary)
            .multilineTextAlignment(alignLeading ? .leading : .trailing)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: alignLeading ? .infinity : nil, alignment: alignLeading ? .leading : .trailing)
        if let identifier {
            text.accessibilityIdentifier(identifier)
        } else {
            text
        }
    }
}

struct LocationConsentSection: View {
    @ObservedObject var viewModel: FieldViewModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var state: Components.Schemas.LocationConsentState {
        viewModel.locationConsent?.state ?? .noRecord
    }

    @ViewBuilder
    var body: some View {
        Section {
            consentControls
        } header: {
            Text("location_consent_title")
                .foregroundStyle(.primary)
                .accessibilityIdentifier(FieldAccessibilityID.locationConsentTitle)
        }
        .headerProminence(.increased)
    }

    @ViewBuilder
    private var consentControls: some View {
            consentValueRow(
                labelKey: "location_consent_state",
                labelIdentifier: FieldAccessibilityID.locationConsentStateLabel,
                value: localizedString(locationConsentStateKey(state)),
                identifier: FieldAccessibilityID.locationConsentStateValue
            )

            consentValueRow(
                labelKey: "location_consent_collection",
                labelIdentifier: FieldAccessibilityID.locationConsentCollectionLabel,
                value: localizedString(viewModel.locationConsent?.mayCollect == true ? "yes" : "no"),
                identifier: FieldAccessibilityID.locationConsentCollectionValue
            )

            switch state {
            case .noRecord:
                Button {
                    Task { await viewModel.grantLocationConsent() }
                } label: {
                    consentButtonLabel("location_consent_grant")
                }
                .disabled(viewModel.isLoading)
                .accessibilityIdentifier(FieldAccessibilityID.locationConsentGrantButton)
            case .withdrawn:
                Button {
                    Task { await viewModel.grantLocationConsent() }
                } label: {
                    consentButtonLabel("location_consent_regain")
                }
                .disabled(viewModel.isLoading)
                .accessibilityIdentifier(FieldAccessibilityID.locationConsentGrantButton)
            case .granted:
                Button {
                    Task { await viewModel.suspendLocationConsent() }
                } label: {
                    consentButtonLabel("location_consent_suspend")
                }
                .disabled(viewModel.isLoading)
                .accessibilityIdentifier(FieldAccessibilityID.locationConsentSuspendButton)

                withdrawButton
            case .suspended:
                Button {
                    Task { await viewModel.resumeLocationConsent() }
                } label: {
                    consentButtonLabel("location_consent_resume")
                }
                .disabled(viewModel.isLoading)
                .accessibilityIdentifier(FieldAccessibilityID.locationConsentResumeButton)

                withdrawButton
            }
    }

    @ViewBuilder
    private func consentValueRow(
        labelKey: LocalizedStringKey,
        labelIdentifier: String,
        value: String,
        identifier: String
    ) -> some View {
        let usesVerticalLayout = dynamicTypeSize.isAccessibilitySize
        let layout = usesVerticalLayout
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))
        layout {
            consentText(labelKey)
                .accessibilityIdentifier(labelIdentifier)
            if usesVerticalLayout == false {
                Spacer(minLength: 12)
            }
            consentValueText(value, identifier: identifier, alignLeading: usesVerticalLayout)
        }
    }

    private func consentText(_ key: LocalizedStringKey) -> some View {
        Text(key)
            .font(.body)
            .foregroundStyle(.primary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func consentValueText(_ value: String, identifier: String, alignLeading: Bool) -> some View {
        Text(value)
            .font(.body)
            .foregroundStyle(.primary)
            .multilineTextAlignment(alignLeading ? .leading : .trailing)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: alignLeading ? .infinity : nil, alignment: alignLeading ? .leading : .trailing)
            .accessibilityIdentifier(identifier)
    }

    private func consentButtonLabel(_ key: LocalizedStringKey) -> some View {
        Text(key)
            .font(.body)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var withdrawButton: some View {
        Button(role: .destructive) {
            Task { await viewModel.withdrawLocationConsent() }
        } label: {
            consentButtonLabel("location_consent_withdraw")
        }
        .disabled(viewModel.isLoading)
        .accessibilityIdentifier(FieldAccessibilityID.locationConsentWithdrawButton)
    }
}

struct FieldChip: View {
    let key: String

    var body: some View {
        Text(LocalizedStringKey(key))
            .font(.caption)
            .foregroundStyle(.primary)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(.thinMaterial, in: Capsule())
    }
}

private extension View {
    @ViewBuilder
    func inlineNavigationTitle() -> some View {
        #if os(iOS)
        navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }

    @ViewBuilder
    func workOrderDetailPresentation<Item: Identifiable, Presented: View>(
        item: Binding<Item?>,
        @ViewBuilder content: @escaping (Item) -> Presented
    ) -> some View {
        #if os(iOS)
        fullScreenCover(item: item, content: content)
        #else
        sheet(item: item, content: content)
        #endif
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
