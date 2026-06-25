import XCTest

/// Mirror of `FieldAccessibilityID` (the production namespace in the app target).
///
/// A UITest bundle and the host app are separate modules, so the identifier
/// strings are duplicated here. `FieldAccessibilityIDParityTests` fails if the
/// two lists ever drift, keeping this honest. Only the identifiers the tests
/// actually query are mirrored.
enum AID {
    static let loginUserIDField = "login.userIDField"
    static let loginButton = "login.button"
    static let loginErrorMessage = "login.errorMessage"

    static let authenticatedTabs = "shell.authenticatedTabs"
    static let todayTab = "shell.todayTab"
    static let messengerTab = "shell.messengerTab"

    static let todayList = "today.list"
    static let todayEmpty = "today.empty"
    static let todayRefreshButton = "today.refresh"
    static let todayLogoutButton = "today.logout"
    static let todayLoading = "today.loading"
    static func workOrderRow(_ id: String) -> String { "today.workOrderRow.\(id)" }

    static let detailView = "detail.view"
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
    static let messengerTitle = "메신저"
    static let messengerEmptyThreads = "표시할 대화방이 없습니다."
    static let messengerSelectThread = "대화방을 선택하세요."
    static let messengerSearchNoResults = "검색 결과가 없습니다."
    static let logout = "로그아웃"
    static let refresh = "새로고침"
    static let startWork = "작업 시작"
    static let submitReport = "보고 제출"
    static let captureEvidence = "증빙 촬영"
    static let locationConsentTitle = "GPS 위치 동의"
    static let errorInvalidUserID = "올바른 사용자 ID 형식이 아닙니다."
    static let loginFailed = "로그인에 실패했습니다."
    static let cameraPermissionDenied = "카메라 권한이 필요합니다."
    static let cameraShutter = "촬영"
    static let cameraCancel = "취소"
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

/// Base case: real session seeding + launch helpers shared by every spec.
///
/// `setUp` mints a real backend session and seeds it into the real Keychain so
/// the app's normal `restore()` path authenticates. If no real session source is
/// configured (local dev, unsigned build) every test in the suite skips with an
/// actionable message — it never fakes auth.
class FieldUITestCase: XCTestCase {
    var app: XCUIApplication!
    private(set) var seededSession = false

    override func setUp() async throws {
        try await super.setUp()
        continueAfterFailure = false

        let tokens = try await RealBackendSession.fetch()
        try RealSessionSeed.seed(SeedTokens(accessToken: tokens.accessToken, refreshToken: tokens.refreshToken))
        seededSession = true
    }

    override func tearDown() async throws {
        if seededSession {
            RealSessionSeed.clear()
        }
        // Appearance is process-global to the Simulator; reset so a dark-mode
        // test cannot bleed into a later light-mode contrast audit.
        XCUIDevice.shared.appearance = .light
        app = nil
        try await super.tearDown()
    }

    /// Launch the app under the given presentation. The base URL is passed
    /// through so the app talks to the same real backend the session was minted
    /// against (`AppContainer.resolveServerURL()` reads `MAINTENANCE_API_BASE_URL`).
    @discardableResult
    func launchApp(_ presentation: Presentation = .standard) -> XCUIApplication {
        // Drive light/dark via the supported device-appearance API before launch.
        XCUIDevice.shared.appearance = presentation.deviceAppearance
        let app = XCUIApplication()
        app.launchArguments += presentation.launchArguments
        if let baseURL = ProcessInfo.processInfo.environment["MNT_UITEST_BASE_URL"] {
            app.launchEnvironment["MAINTENANCE_API_BASE_URL"] = baseURL
        }
        app.launch()
        self.app = app
        return app
    }

    /// Wait until the authenticated shell is on screen (the real session was
    /// restored). Anchors on the reliably-queryable Korean Today title /
    /// tab-bar label rather than a SwiftUI container identifier (TabView/List
    /// containers are not guaranteed to surface their `accessibilityIdentifier`
    /// as queryable elements). Fails the test if the app stays on login.
    @discardableResult
    func waitForAuthenticatedShell(timeout: TimeInterval = 20) -> XCUIApplication {
        // Reaching the Today title (오늘 작업) or the tab bar proves we are past
        // the login form. The login user-id field must be absent.
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

    /// Tap a tab-bar item by its visible Korean label, tolerating whether the
    /// element resolves under the `tabBars` query or the flat `buttons` query
    /// (SwiftUI's TabView exposes tab items differently across OS versions).
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

    /// Standard-conformance audit assertion shared by every screen spec.
    /// Scoped to the audit types meaningful for these views: contrast, clipping,
    /// element descriptions, traits, Dynamic Type, hit regions, element
    /// detection. Real issues must be fixed in the SwiftUI views, not suppressed.
    ///
    /// Strictness gate: by default the audit hard-fails on any issue. Because the
    /// SwiftUI views have not yet been observed under a real Simulator audit
    /// (this suite is CI-only), the first integration run sets
    /// `MNT_UITEST_AUDIT_STRICT=0`, under which findings are recorded as an
    /// XCTAttachment (so they are triaged and the views fixed) rather than
    /// failing the bootstrap run. Once the views are clean, CI sets it to `1`
    /// (the default) and the audit becomes a hard gate. This never suppresses a
    /// finding silently — non-strict mode still surfaces every issue in the
    /// result bundle.
    func assertNoAccessibilityIssues(
        for auditTypes: XCUIAccessibilityAuditType = [
            .contrast,
            .dynamicType,
            .elementDetection,
            .hitRegion,
            .sufficientElementDescription,
            .textClipped,
            .trait,
        ],
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let strict = ProcessInfo.processInfo.environment["MNT_UITEST_AUDIT_STRICT"] != "0"
        var findings: [String] = []
        do {
            try app.performAccessibilityAudit(for: auditTypes) { issue in
                findings.append("[\(issue.auditType)] \(issue.compactDescription)")
                // In strict mode, return false so XCTest records the issue and
                // the audit throws (hard failure). In non-strict bootstrap mode,
                // return true to "handle" it ourselves — we still attach it below.
                return strict ? false : true
            }
        } catch {
            XCTFail("Accessibility audit reported issues: \(error)\n\(findings.joined(separator: "\n"))", file: file, line: line)
            return
        }
        if findings.isEmpty == false {
            let attachment = XCTAttachment(string: findings.joined(separator: "\n"))
            attachment.name = "AccessibilityAuditFindings"
            attachment.lifetime = .keepAlways
            add(attachment)
            if strict {
                XCTFail("Accessibility audit reported \(findings.count) issue(s).", file: file, line: line)
            }
        }
    }
}
