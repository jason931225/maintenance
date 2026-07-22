import Foundation

/// Stable accessibility identifiers for the field app's SwiftUI views.
///
/// These are production-appropriate: they give VoiceOver/automation a stable
/// anchor that does not shift when the Korean copy is retranslated. The XCUITest
/// suite (CI-only) queries elements by these exact identifiers; keeping them in
/// one namespace keeps the production views and the tests in lock-step without
/// scattering magic strings.
///
/// The string values are duplicated (not shared at compile time) by the UITests
/// target, because an XCUITest bundle and the host app are separate modules. The
/// duplication is intentional and checked by the host-side
/// `check-ios-ui-test-fail-closed.mjs` gate, which compares both enum declarations
/// (including dynamic formatters) and fails if they drift.
public enum FieldAccessibilityID {
    // Login
    public static let loginUserIDField = "login.userIDField"
    public static let loginButton = "login.button"
    public static let loginErrorMessage = "login.errorMessage"

    // Authenticated shell
    public static let authenticatedTabs = "shell.authenticatedTabs"
    public static let workHubTab = "shell.workHubTab"
    public static let messengerTab = "shell.messengerTab"
    public static let operationsTab = "shell.operationsTab"

    // Work hub
    public static let workHubList = "workHub.list"
    public static func workHubCollaborationAction(_ kind: String) -> String { "workHub.collaborationAction.\(kind)" }

    // Operations inbox
    public static let operationsList = "operations.list"
    public static let operationsRefreshButton = "operations.refresh"
    public static let operationsApprovalCommentField = "operations.approvalComment"
    public static func operationsMailThread(_ id: String) -> String { "operations.mailThread.\(id)" }
    public static func operationsCalendarEvent(_ id: String) -> String { "operations.calendarEvent.\(id)" }
    public static func operationsPoll(_ id: String) -> String { "operations.poll.\(id)" }

    // Today (dispatch) list
    public static let todayList = "today.list"
    public static let todayEmpty = "today.empty"
    public static let todayRefreshButton = "today.refresh"
    public static let todayLogoutButton = "today.logout"
    public static let todayLoading = "today.loading"

    /// Per-row identifier for a dispatched work order, keyed by the work-order id.
    public static func workOrderRow(_ id: String) -> String { "today.workOrderRow.\(id)" }

    // Work-order detail
    public static let detailView = "detail.view"
    public static let detailStatus = "detail.status"
    public static let detailStartWorkButton = "detail.startWork"
    public static let detailResultTypePicker = "detail.resultTypePicker"
    public static let detailDiagnosisField = "detail.diagnosisField"
    public static let detailActionTakenField = "detail.actionTakenField"
    public static let detailSubmitReportButton = "detail.submitReport"
    public static let detailCaptureEvidenceButton = "detail.captureEvidence"
    public static let detailBackButton = "detail.back"
    public static let detailMessage = "detail.message"

    // Camera capture
    public static let cameraShutterButton = "camera.shutter"
    public static let cameraCancelButton = "camera.cancel"
    public static let cameraOpenSettingsButton = "camera.openSettings"
    public static let cameraPermissionDenied = "camera.permissionDenied"
    public static let cameraPermissionRequesting = "camera.permissionRequesting"
    public static let cameraUnavailable = "camera.unavailable"

    // Location consent (shared section, present in Today + Detail)
    public static let locationConsentGrantButton = "locationConsent.grant"
    public static let locationConsentSuspendButton = "locationConsent.suspend"
    public static let locationConsentResumeButton = "locationConsent.resume"
    public static let locationConsentWithdrawButton = "locationConsent.withdraw"

    // Messenger
    public static let messengerSearchField = "messenger.searchField"
    public static let messengerSearchButton = "messenger.searchButton"
    public static let messengerSearchNoResults = "messenger.searchNoResults"
    public static let messengerEmptyThreads = "messenger.emptyThreads"
    public static let messengerSelectThreadPrompt = "messenger.selectThreadPrompt"
    public static let messengerComposerField = "messenger.composerField"
    public static let messengerSendButton = "messenger.sendButton"
    public static let messengerRefreshButton = "messenger.refresh"
    public static let messengerLogoutButton = "messenger.logout"

    /// Per-row identifier for a messenger thread, keyed by the thread id.
    public static func messengerThreadRow(_ id: String) -> String { "messenger.threadRow.\(id)" }

    /// Per-row identifier for a persisted messenger message, keyed by message id.
    public static func messengerMessageRow(_ id: String) -> String { "messenger.messageRow.\(id)" }

    /// Per-row identifier for a messenger search result, keyed by message id.
    ///
    /// Search results and the selected thread can contain the same persisted
    /// message. Keeping their section anchors distinct prevents an XCUITest
    /// query from resolving the wrong visible row.
    public static func messengerSearchResultRow(_ id: String) -> String { "messenger.searchResultRow.\(id)" }

    /// Static identifiers exposed by the app. Dynamic formatters are intentionally
    /// absent from this value list and are covered by the host-side parity gate.
    public static let allStableIdentifiers: [String] = [
        loginUserIDField,
        loginButton,
        loginErrorMessage,
        authenticatedTabs,
        workHubTab,
        messengerTab,
        operationsTab,
        workHubList,
        operationsList,
        operationsRefreshButton,
        operationsApprovalCommentField,
        todayList,
        todayEmpty,
        todayRefreshButton,
        todayLogoutButton,
        todayLoading,
        detailView,
        detailStatus,
        detailStartWorkButton,
        detailResultTypePicker,
        detailDiagnosisField,
        detailActionTakenField,
        detailSubmitReportButton,
        detailCaptureEvidenceButton,
        detailBackButton,
        detailMessage,
        cameraShutterButton,
        cameraCancelButton,
        cameraOpenSettingsButton,
        cameraPermissionDenied,
        cameraPermissionRequesting,
        cameraUnavailable,
        locationConsentGrantButton,
        locationConsentSuspendButton,
        locationConsentResumeButton,
        locationConsentWithdrawButton,
        messengerSearchField,
        messengerSearchButton,
        messengerSearchNoResults,
        messengerEmptyThreads,
        messengerSelectThreadPrompt,
        messengerComposerField,
        messengerSendButton,
        messengerRefreshButton,
        messengerLogoutButton,
    ]
}
