import XCTest

/// Mirror of `FieldAccessibilityID` (the production namespace in the app target).
///
/// A UITest bundle and the host app are separate modules, so the identifier
/// strings are duplicated here. The host-side iOS fail-closed gate compares the
/// complete production and UITest enum declarations, including dynamic
/// formatters, so a one-sided addition or value change fails before Xcode runs.
enum AID {
    static let loginUserIDField = "login.userIDField"
    static let loginButton = "login.button"
    static let loginErrorMessage = "login.errorMessage"

    static let authenticatedTabs = "shell.authenticatedTabs"
    static let todayTab = "shell.todayTab"
    static let workHubTab = "shell.workHubTab"
    static let messengerTab = "shell.messengerTab"
    static let operationsTab = "shell.operationsTab"

    static let workHubList = "workHub.list"
    static func workHubCollaborationAction(_ kind: String) -> String { "workHub.collaborationAction.\(kind)" }
    static let operationsList = "operations.list"
    static let operationsRefreshButton = "operations.refresh"
    static let operationsApprovalCommentField = "operations.approvalComment"
    static func operationsMailThread(_ id: String) -> String { "operations.mailThread.\(id)" }
    static func operationsCalendarEvent(_ id: String) -> String { "operations.calendarEvent.\(id)" }
    static func operationsPoll(_ id: String) -> String { "operations.poll.\(id)" }
    static let todayList = "today.list"
    static let todayEmpty = "today.empty"
    static let todayRefreshButton = "today.refresh"
    static let todayLogoutButton = "today.logout"
    static let todayLoading = "today.loading"
    static func workOrderRow(_ id: String) -> String { "today.workOrderRow.\(id)" }

    static let detailView = "detail.view"
    static let detailStatus = "detail.status"
    static let detailStartWorkButton = "detail.startWork"
    static let detailResultTypePicker = "detail.resultTypePicker"
    static let detailDiagnosisField = "detail.diagnosisField"
    static let detailActionTakenField = "detail.actionTakenField"
    static let detailSubmitReportButton = "detail.submitReport"
    static let detailCaptureEvidenceButton = "detail.captureEvidence"
    static let detailBackButton = "detail.back"
    static let detailMessage = "detail.message"

    static let cameraShutterButton = "camera.shutter"
    static let cameraCancelButton = "camera.cancel"
    static let cameraOpenSettingsButton = "camera.openSettings"
    static let cameraPermissionDenied = "camera.permissionDenied"
    static let cameraPermissionRequesting = "camera.permissionRequesting"
    static let cameraUnavailable = "camera.unavailable"

    static let locationConsentGrantButton = "locationConsent.grant"
    static let locationConsentSuspendButton = "locationConsent.suspend"
    static let locationConsentResumeButton = "locationConsent.resume"
    static let locationConsentWithdrawButton = "locationConsent.withdraw"

    static let messengerSearchField = "messenger.searchField"
    static let messengerSearchButton = "messenger.searchButton"
    static let messengerSearchNoResults = "messenger.searchNoResults"
    static let messengerEmptyThreads = "messenger.emptyThreads"
    static let messengerSelectThreadPrompt = "messenger.selectThreadPrompt"
    static let messengerComposerField = "messenger.composerField"
    static let messengerSendButton = "messenger.sendButton"
    static let messengerRefreshButton = "messenger.refresh"
    static let messengerLogoutButton = "messenger.logout"
    static func messengerThreadRow(_ id: String) -> String { "messenger.threadRow.\(id)" }
    static func messengerMessageRow(_ id: String) -> String { "messenger.messageRow.\(id)" }
    static func messengerSearchResultRow(_ id: String) -> String { "messenger.searchResultRow.\(id)" }
}

/// The Korean strings the suite asserts as the real, visible outcomes. These are
/// the canonical values from
/// `ios/Sources/MaintenanceFieldApp/Resources/ko.lproj/Localizable.strings`; the
/// suite checks the rendered Korean (XCUITest sees rendered text, not keys).
enum KO {
    static let loginTitle = "패스키 로그인"
    static let loginButton = "로그인"
    static let todayTitle = "오늘 작업"
    static let emptyToday = "오늘 배정된 작업이 없습니다."
    static let workHubTitle = "업무 허브"
    static let messengerTitle = "메신저"
    static let messengerEmptyThreads = "표시할 대화방이 없습니다."
    static let messengerSelectThread = "대화방을 선택하세요."
    static let messengerSearchNoResults = "검색 결과가 없습니다."
    static let messengerSendPending = "오프라인 메시지로 저장되었습니다."
    static let logout = "로그아웃"
    static let refresh = "새로고침"
    static let startWork = "작업 시작"
    static let inProgress = "진행 중"
    static let submitReport = "보고 제출"
    static let requiredField = "필수 입력값입니다."
    static let reportSuccessMessage = "보고가 제출되었습니다."
    static let reportSubmitted = "보고 완료"
    static let captureEvidence = "증빙 촬영"
    static let locationConsentTitle = "GPS 위치 동의"
    static let locationConsentNoRecord = "미동의"
    static let locationConsentGranted = "동의됨"
    static let locationConsentSuspended = "GPS 꺼짐"
    static let locationConsentWithdrawn = "철회됨"
    static let yes = "예"
    static let no = "아니오"
    static let errorInvalidUserID = "올바른 사용자 ID 형식이 아닙니다."
    static let loginFailed = "로그인에 실패했습니다."
    static let cameraPermissionDenied = "카메라 권한이 필요합니다."
    static let cameraShutter = "촬영"
    static let cameraCancel = "취소"
    static let operationFailed = "처리에 실패했습니다."
}

/// Launch arguments that make rendered copy deterministic on GitHub's hosted
/// runners. The product's field UI is Korean-first, while the runner locale is
/// not guaranteed to be Korean, so every UI-test launch pins the app language.
enum LaunchLocale {
    static let arguments = ["-AppleLanguages", "(ko)", "-AppleLocale", "ko_KR"]
}

/// Launch presentation variants the suite runs each screen under, so the
/// accessibility audit covers the real Dynamic Type / dark-mode conditions the
/// field uses (gloves, bright sun, night shift).
enum Presentation {
    case standard
    case largestDynamicType
    case darkMode

    /// Launch arguments that drive the Dynamic Type presentation.
    /// `-UIPreferredContentSizeCategoryName` is the well-known UIKit
    /// NSUserDefaults key UIKit reads at startup (the only practical mechanism
    /// for driving content size from a UI test; it works reliably in the
    /// Simulator). Dark mode is NOT driven here — it uses the supported
    /// `XCUIDevice.shared.appearance` API, applied by `launchApp(_:)`.
    var launchArguments: [String] {
        switch self {
        case .standard, .darkMode:
            return []
        case .largestDynamicType:
            return [
                "-UIPreferredContentSizeCategoryName",
                "UICTContentSizeCategoryAccessibilityXXXL",
            ]
        }
    }

    /// The device appearance this presentation requires. Applied via the
    /// supported `XCUIDevice.shared.appearance` property (iOS 15+) BEFORE launch
    /// — the documented, stable way to drive light/dark in XCUITest (per Apple's
    /// XCUIDevice.h; the `-UIUserInterfaceStyle` launch argument is undocumented
    /// and unreliable).
    var deviceAppearance: XCUIDevice.Appearance {
        switch self {
        case .darkMode:
            return .dark
        case .standard, .largestDynamicType:
            return .light
        }
    }
}

/// Required deterministic IDs from the isolated workflow fixture. Every
/// state-changing/detail test names the exact record it needs; a missing fixture
/// is a failure, never an empty-list success or skipped test.
enum UITestFixture {
    static let detailWorkOrderID = "MNT_UITEST_WORK_ORDER_ID_DETAIL"
    static let startWorkOrderID = "MNT_UITEST_WORK_ORDER_ID_START"
    static let reportWorkOrderID = "MNT_UITEST_WORK_ORDER_ID_REPORT"
    static let reportSuccessWorkOrderID = "MNT_UITEST_WORK_ORDER_ID_REPORT_SUCCESS"
    static let cameraWorkOrderID = "MNT_UITEST_WORK_ORDER_ID_CAMERA"
    static let messengerThreadID = "MNT_UITEST_MESSENGER_THREAD_ID"
    static let messengerInitialMessageID = "MNT_UITEST_MESSENGER_INITIAL_MESSAGE_ID"

    enum Error: Swift.Error, LocalizedError {
        case missing(String)

        var errorDescription: String? {
            switch self {
            case let .missing(key):
                return "Required isolated UI-test fixture \(key) is missing or empty. The workflow must seed this exact work order before xcodebuild."
            }
        }
    }

    static func requiredID(
        _ key: String,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) throws -> String {
        guard let value = environment[key], UUID(uuidString: value) != nil else {
            throw Error.missing(key)
        }
        return value
    }
}

/// Base case: real session seeding + launch helpers shared by every spec.
///
/// Before each test-class shard, the workflow injects a fresh server-minted
/// access/refresh pair into the runner. This case writes that shard-local pair
/// into the repository-owned seeder app, which writes the production Keychain
/// layout under its own signed entitlement. The unmodified app then restores
/// normally. Any missing runner input, helper result, or fixture throws and
/// fails XCTest rather than permitting an all-skipped/fake success.
class FieldUITestCase: XCTestCase {
    var app: XCUIApplication!
    private(set) var seededSession = false

    override func setUp() async throws {
        try await super.setUp()
        continueAfterFailure = false

        let tokens = try RealBackendSession.tokens()
        try RealSessionSeed.seed(tokens)
        seededSession = true
    }

    override func tearDown() async throws {
        app?.terminate()
        if seededSession {
            try RealSessionSeed.clear()
        }
        // Appearance is process-global to the Simulator; reset from the main
        // actor so Swift 6 does not diagnose UI mutation from async teardown.
        await MainActor.run {
            XCUIDevice.shared.appearance = .light
        }
        app = nil
        try await super.tearDown()
    }

    /// Launch the app against the runner's isolated local backend.
    @discardableResult
    func launchApp(_ presentation: Presentation = .standard) async throws -> XCUIApplication {
        await MainActor.run {
            XCUIDevice.shared.appearance = presentation.deviceAppearance
        }
        let app = XCUIApplication()
        app.launchArguments += LaunchLocale.arguments
        app.launchArguments += presentation.launchArguments
        app.launchEnvironment["MAINTENANCE_API_BASE_URL"] = try RealBackendSession.baseURL()
        app.launch()
        self.app = app
        return app
    }

    /// Launch a deliberately signed-out app while retaining the same local API
    /// routing as authenticated tests.
    @discardableResult
    func launchSignedOutApp(_ presentation: Presentation = .standard) async throws -> XCUIApplication {
        try RealSessionSeed.clear()
        return try await launchApp(presentation)
    }

    /// Resolve an exact seeded row; list scanning / first-row selection is
    /// intentionally forbidden because it makes state-changing tests nonrepeatable.
    func openSeededWorkOrder(
        fixtureKey: String,
        timeout: TimeInterval = 15
    ) throws {
        let id = try UITestFixture.requiredID(fixtureKey)
        let row = app.buttons[AID.workOrderRow(id)]
        guard row.waitForExistence(timeout: timeout) else {
            throw UITestFixture.Error.missing("\(fixtureKey) (seeded ID \(id) was not rendered in Today)")
        }
        row.tap()
        guard app.otherElements[AID.detailView].waitForExistence(timeout: 10) else {
            throw UITestFixture.Error.missing("\(fixtureKey) (seeded ID \(id) did not open detail)")
        }
    }

    @discardableResult
    func waitForAuthenticatedShell(timeout: TimeInterval = 20) -> XCUIApplication {
        let todayTitle = app.staticTexts[KO.todayTitle]
        let todayTab = app.tabBars.buttons[KO.todayTitle]
        let appeared = todayTitle.waitForExistence(timeout: timeout)
            || todayTab.waitForExistence(timeout: 1)
            || app.collectionViews[AID.todayList].waitForExistence(timeout: 1)
        XCTAssertTrue(
            appeared,
            "Authenticated shell did not appear — the seeded real session was not restored."
        )
        XCTAssertFalse(
            app.textFields[AID.loginUserIDField].exists,
            "The login field must be absent once the real session is restored."
        )
        return app
    }

    @discardableResult
    func tapTab(_ koreanLabel: String, timeout: TimeInterval = 10) -> Bool {
        let inTabBar = app.tabBars.buttons[koreanLabel]
        if inTabBar.waitForExistence(timeout: timeout) {
            inTabBar.tap()
            return true
        }
        let flat = app.buttons[koreanLabel]
        if flat.waitForExistence(timeout: 1) {
            flat.tap()
            return true
        }
        return false
    }

    /// Audit the complete surface with XCTest's strict default behavior. There
    /// is no issue handler: every issue is an XCTest failure.
    func assertNoAccessibilityIssues(
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        do {
            try app.performAccessibilityAudit(for: .all)
        } catch {
            XCTFail("Accessibility audit reported issues: \(error)", file: file, line: line)
        }
    }
}
