import XCTest
import UIKit

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
    static let todayLocationConsentButton = "today.locationConsent"
    static let todayLocationConsentSheet = "today.locationConsent.sheet"
    static let todayLocationConsentCloseButton = "today.locationConsent.close"
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
    static let detailSymptomLabel = "detail.symptom.label"
    static let detailSymptomValue = "detail.symptom.value"

    static let cameraShutterButton = "camera.shutter"
    static let cameraCancelButton = "camera.cancel"
    static let cameraOpenSettingsButton = "camera.openSettings"
    static let cameraPermissionDenied = "camera.permissionDenied"
    static let cameraPermissionRequesting = "camera.permissionRequesting"
    static let cameraUnavailable = "camera.unavailable"

    static let locationConsentTitle = "locationConsent.title"
    static let locationConsentStateLabel = "locationConsent.stateLabel"
    static let locationConsentCollectionLabel = "locationConsent.collectionLabel"
    static let locationConsentGrantButton = "locationConsent.grant"
    static let locationConsentSuspendButton = "locationConsent.suspend"
    static let locationConsentResumeButton = "locationConsent.resume"
    static let locationConsentWithdrawButton = "locationConsent.withdraw"
    static let locationConsentStateValue = "locationConsent.stateValue"
    static let locationConsentCollectionValue = "locationConsent.collectionValue"

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
    static func messengerMessageTimestamp(_ id: String) -> String { "messenger.messageTimestamp.\(id)" }
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

/// Presentation is preconditioned by the shell runner (simctl) before this
/// XCTest process starts. Tests only assert the rendered result; they never
/// mutate process-global Simulator presentation state themselves.
enum Presentation {
    case standard
    case largestDynamicType
    case darkMode

    var expectedDarkAppearance: Bool {
        self == .darkMode
    }
}

/// Creates an unlaunched app wired to the isolated backend. The shell owns
/// Simulator appearance and Dynamic Type; tests must not smuggle either through
/// app launch arguments because that diverges from production process state.
@MainActor
extension XCUIApplication {
    static func fieldUITestApp(
        presentation _: Presentation = .standard,
        baseURL: String? = nil
    ) throws -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += LaunchLocale.arguments
        app.launchEnvironment["MAINTENANCE_API_BASE_URL"] = try baseURL ?? RealBackendSession.baseURL()
        return app
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
    static let adminApproveWorkOrderID = "MNT_UITEST_WORK_ORDER_ID_ADMIN_APPROVE"
    static let adminRejectWorkOrderID = "MNT_UITEST_WORK_ORDER_ID_ADMIN_REJECT"
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

/// Finds one exact deterministic work-order row without assuming SwiftUI has
/// materialized off-screen List content. The location-consent section can fill
/// the initial viewport (especially at larger Dynamic Type sizes), so a direct
/// `waitForExistence` is not evidence that the API response was empty.
@MainActor
func workOrderRowActivationPoint(
    in app: XCUIApplication,
    row: XCUIElement,
    list: XCUIElement
) -> XCUICoordinate? {
    guard row.exists, row.isHittable, list.exists, row.frame.height > 0 else { return nil }

    var viewport = list.frame
    let navigationBar = app.navigationBars.firstMatch
    if navigationBar.exists {
        let visibleTop = max(viewport.minY, navigationBar.frame.maxY)
        viewport = CGRect(
            x: viewport.minX,
            y: visibleTop,
            width: viewport.width,
            height: max(0, viewport.maxY - visibleTop)
        )
    }

    let tabBar = app.tabBars.firstMatch
    if tabBar.exists {
        // The floating tab bar's dimming/material surface extends above its
        // reported accessibility frame. Reserve one tab-bar height so a row
        // is never accepted while its activation point is under that chrome.
        let tabChromeTop = tabBar.frame.minY - tabBar.frame.height
        let visibleBottom = min(viewport.maxY, tabChromeTop)
        viewport.size.height = max(0, visibleBottom - viewport.minY)
    }

    // A partially visible SwiftUI Button can report itself hittable even when
    // tapping the midpoint of the visible fragment misses its activation
    // region. Only accept the row once its semantic center is clear of both
    // navigation and floating-tab chrome, then activate that stable center.
    let center = CGPoint(x: row.frame.midX, y: row.frame.midY)
    guard viewport.contains(center) else { return nil }

    return row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
}

@MainActor
func scrollToWorkOrderRow(
    in app: XCUIApplication,
    id: String,
    timeout: TimeInterval = 60,
    maxSwipes: Int = 48
) -> XCUIElement? {
    let row = app.buttons[AID.workOrderRow(id)]
    let list = app.collectionViews[AID.todayList]
    let deadline = Date().addingTimeInterval(timeout)
    let initialProbe = min(timeout, 2)
    let rowAppeared = row.waitForExistence(timeout: initialProbe)

    let listProbe = max(min(deadline.timeIntervalSinceNow, initialProbe), 0)
    guard list.waitForExistence(timeout: listProbe) else { return nil }
    if rowAppeared, workOrderRowActivationPoint(in: app, row: row, list: list) != nil {
        return row
    }

    // A SwiftUI List can preserve a prior scroll position across a terminate /
    // relaunch cycle. Normalize only until the always-present first section is
    // visible, then use short controlled drags so an exact row cannot be skipped
    // by the momentum of a full swipe. Both phases share one deadline.
    let topSentinel = app.staticTexts[KO.locationConsentTitle]
    for _ in 0..<maxSwipes {
        if topSentinel.exists, topSentinel.isHittable { break }
        guard Date() < deadline else { return nil }
        list.swipeDown()
        if workOrderRowActivationPoint(in: app, row: row, list: list) != nil {
            return row
        }
    }

    let dragStart = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.72))
    let dragEnd = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.48))
    for _ in 0..<maxSwipes {
        if workOrderRowActivationPoint(in: app, row: row, list: list) != nil { return row }
        guard Date() < deadline else { return nil }
        dragStart.press(forDuration: 0.1, thenDragTo: dragEnd)
        // The gesture already waits for the application to become idle. A
        // timed existence query here forces XCTest to capture a full hierarchy
        // on every miss, turning a bounded list scan into a 30-second crawl at
        // accessibility text sizes. Probe synchronously after each settled
        // drag so all 48 positions fit inside the shared deadline.
        if workOrderRowActivationPoint(in: app, row: row, list: list) != nil {
            return row
        }
    }
    return nil
}

@MainActor
func assertTodayListEndsAtOrAboveTabBar(
    in app: XCUIApplication,
    file: StaticString = #filePath,
    line: UInt = #line
) {
    let list = app.collectionViews[AID.todayList]
    let tabBar = app.tabBars.firstMatch
    guard list.waitForExistence(timeout: 15) else {
        XCTFail("Today list must exist before tab-bar geometry is evaluated.", file: file, line: line)
        return
    }
    guard tabBar.waitForExistence(timeout: 15) else {
        XCTFail("Authenticated tab bar must exist before Today geometry is evaluated.", file: file, line: line)
        return
    }
    XCTAssertLessThanOrEqual(
        list.frame.maxY,
        tabBar.frame.minY + 1,
        "Today's scroll viewport must end at or above the floating tab bar.",
        file: file,
        line: line
    )
    XCTAssertGreaterThanOrEqual(
        list.frame.maxY,
        tabBar.frame.minY - 1,
        "Today's scroll viewport must use the complete unobscured tab content guide.",
        file: file,
        line: line
    )
}

/// Finds a lazy SwiftUI Form/List element without relying on its initial
/// accessibility materialization. The caller supplies the first-section
/// sentinel so a relaunch starts from a known scroll origin before controlled
/// forward drags search for one exact target. Every wait and gesture shares a
/// single absolute deadline.
@MainActor
func scrollToElement(
    _ element: XCUIElement,
    in container: XCUIElement,
    topSentinel: XCUIElement,
    timeout: TimeInterval = 15,
    maxSwipes: Int = 16
) -> XCUIElement? {
    let deadline = Date().addingTimeInterval(timeout)
    let initialProbe = min(timeout, 2)
    if element.waitForExistence(timeout: initialProbe), element.isHittable {
        return element
    }

    let containerProbe = max(min(deadline.timeIntervalSinceNow, initialProbe), 0)
    guard container.waitForExistence(timeout: containerProbe) else { return nil }

    for _ in 0..<maxSwipes {
        if topSentinel.exists, topSentinel.isHittable { break }
        guard Date() < deadline else { return nil }
        container.swipeDown()
        if element.exists, element.isHittable { return element }
    }

    // Drag through the Form's interior trailing gutter rather than the
    // centered multiline editor, the leading-edge navigation gesture region,
    // or the system scroll-indicator strip. A focused TextField consumes
    // center-origin gestures, while either edge can claim a drag before the
    // Form applies its immediate keyboard-dismiss policy.
    let origin = container.coordinate(withNormalizedOffset: .zero)
    let trailingGutterX = max(container.frame.width * 0.9, 8)
    let dragStart = origin.withOffset(
        CGVector(dx: trailingGutterX, dy: container.frame.height * 0.50)
    )
    let dragEnd = origin.withOffset(
        CGVector(dx: trailingGutterX, dy: container.frame.height * 0.28)
    )
    for _ in 0..<maxSwipes {
        if element.exists, element.isHittable { return element }
        guard Date() < deadline else { return nil }
        dragStart.press(forDuration: 0.1, thenDragTo: dragEnd)
        if element.exists, element.isHittable {
            return element
        }
    }
    return nil
}

/// Base case: real session seeding + launch helpers shared by every spec.
///
/// Before each test-class shard, the workflow injects a fresh server-minted
/// access/refresh pair into the runner. This case writes that shard-local pair
/// into the repository-owned seeder app, which writes the production Keychain
/// layout under its own signed entitlement. The unmodified app then restores
/// normally. Any missing runner input, helper result, or fixture throws and
/// fails XCTest rather than permitting an all-skipped/fake success.
@MainActor
class FieldUITestCase: XCTestCase {
    var app: XCUIApplication!
    private(set) var seededSession = false

    deinit {}

    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = false

        let tokens = try RealBackendSession.tokens()
        try RealSessionSeed.seed(tokens)
        seededSession = true
    }

    override func tearDownWithError() throws {
        app?.terminate()
        if seededSession {
            try RealSessionSeed.clear()
        }
        app = nil
        try super.tearDownWithError()
    }

    /// Proves that the application rendered the requested appearance rather
    /// than merely accepting the Simulator setting. The system-managed tab-bar
    /// material exposes a stable interior light/dark reference surface without
    /// any production-only test hook.
    func assertRenderedAppearance(
        _ presentation: Presentation,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let tabBar = app.tabBars.firstMatch
        guard tabBar.waitForExistence(timeout: 10) else {
            XCTFail("Authenticated tab bar is required to verify rendered appearance.", file: file, line: line)
            return
        }

        let screenshot = tabBar.screenshot().image
        guard let cgImage = screenshot.cgImage else {
            XCTFail("Could not rasterize the authenticated tab bar screenshot.", file: file, line: line)
            return
        }

        let width = cgImage.width
        let height = cgImage.height
        guard width > 0, height > 0, let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else {
            XCTFail("Authenticated tab bar screenshot has no measurable sRGB surface.", file: file, line: line)
            return
        }

        var rgba = [UInt8](repeating: 0, count: width * height * 4)
        let rendered = rgba.withUnsafeMutableBytes { bytes -> Bool in
            guard let baseAddress = bytes.baseAddress,
                  let context = CGContext(
                      data: baseAddress,
                      width: width,
                      height: height,
                      bitsPerComponent: 8,
                      bytesPerRow: width * 4,
                      space: colorSpace,
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                          | CGBitmapInfo.byteOrder32Big.rawValue
                  )
            else { return false }
            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard rendered else {
            XCTFail("Could not create an sRGB renderer for the authenticated tab bar.", file: file, line: line)
            return
        }

        let xRange = stride(from: width / 10, to: width * 9 / 10, by: 4)
        let yRange = stride(from: height / 10, to: height * 9 / 10, by: 4)
        var lumaSum = 0.0
        var sampleCount = 0
        for y in yRange {
            for x in xRange {
                let offset = (y * width + x) * 4
                let red = Double(rgba[offset])
                let green = Double(rgba[offset + 1])
                let blue = Double(rgba[offset + 2])
                lumaSum += (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255.0
                sampleCount += 1
            }
        }
        guard sampleCount > 0 else {
            XCTFail("Authenticated tab bar screenshot produced no appearance samples.", file: file, line: line)
            return
        }

        let meanLuma = lumaSum / Double(sampleCount)
        let matches = presentation.expectedDarkAppearance ? meanLuma < 0.35 : meanLuma > 0.65
        if !matches {
            let attachment = XCTAttachment(image: screenshot)
            attachment.name = "Rendered appearance mismatch"
            attachment.lifetime = .keepAlways
            add(attachment)
            let expected = presentation.expectedDarkAppearance ? "dark" : "light"
            XCTFail(
                "Expected rendered \(expected) tab bar; measured mean sRGB luma \(String(format: "%.3f", meanLuma)).",
                file: file,
                line: line
            )
        }
    }

    /// Launch the app against the runner's isolated local backend.
    @discardableResult
    func launchApp(
        _ presentation: Presentation = .standard
    ) async throws -> XCUIApplication {
        let app = try XCUIApplication.fieldUITestApp(
            presentation: presentation
        )
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
        timeout: TimeInterval = 60
    ) throws {
        let id = try UITestFixture.requiredID(fixtureKey)
        guard let row = scrollToWorkOrderRow(in: app, id: id, timeout: timeout) else {
            throw UITestFixture.Error.missing("\(fixtureKey) (seeded ID \(id) was not rendered in Today)")
        }
        let list = app.collectionViews[AID.todayList]
        guard let activationPoint = workOrderRowActivationPoint(in: app, row: row, list: list) else {
            throw UITestFixture.Error.missing("\(fixtureKey) (seeded ID \(id) was not safely visible above navigation chrome)")
        }
        activationPoint.tap()
        let detail = app.descendants(matching: .any)[AID.detailView]
        let back = app.buttons[AID.detailBackButton]
        guard detail.waitForExistence(timeout: 10),
              back.waitForExistence(timeout: 2),
              back.isHittable else {
            throw UITestFixture.Error.missing("\(fixtureKey) (seeded ID \(id) did not open detail)")
        }
    }

    /// Detail is a lazy SwiftUI Form backed by a collection view. Resolve the
    /// exact control before interacting so lower sections are not mistaken for
    /// missing API/UI state merely because they are off-screen.
    func scrollToDetailElement(
        _ element: XCUIElement,
        timeout: TimeInterval = 15,
        maxSwipes: Int = 16
    ) -> XCUIElement? {
        scrollToElement(
            element,
            in: app.descendants(matching: .any)[AID.detailView],
            // The full-screen detail's persistent toolbar button stays mounted
            // while its lazy Form materializes and anchors normalization.
            topSentinel: app.buttons[AID.detailBackButton],
            timeout: timeout,
            maxSwipes: maxSwipes
        )
    }

    /// Waits for one stable accessibility element to expose a rendered value.
    /// This avoids brittle exact static-text lookups when SwiftUI combines a
    /// row label and value into one accessibility label.
    @discardableResult
    func waitForLabel(
        _ element: XCUIElement,
        containing expected: String,
        timeout: TimeInterval = 15
    ) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        guard element.waitForExistence(timeout: min(timeout, 2)) else { return false }
        while Date() < deadline {
            if element.label.contains(expected) { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
        return element.label.contains(expected)
    }

    @discardableResult
    func waitForAuthenticatedShell(timeout: TimeInterval = 20) -> XCUIApplication {
        let todayTab = app.tabBars.buttons[KO.todayTitle]
        let appeared = todayTab.waitForExistence(timeout: timeout)
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
    func tapTab(
        _ koreanLabel: String,
        destination: XCUIElement,
        timeout: TimeInterval = 10
    ) -> Bool {
        let inTabBar = app.tabBars.buttons[koreanLabel]
        guard inTabBar.waitForExistence(timeout: timeout) else { return false }

        func reachedDestination() -> Bool {
            destination.waitForExistence(timeout: 1) && inTabBar.isSelected
        }

        inTabBar.tap()
        if reachedDestination() { return true }

        // iOS floating-tab accessibility frames can overlap. Retry inside the
        // requested tab's outer regions and prove both selected state and the
        // exact destination; a synthesized tap alone is not navigation proof.
        for horizontalOffset in [0.85, 0.15] {
            inTabBar.coordinate(
                withNormalizedOffset: CGVector(dx: horizontalOffset, dy: 0.5)
            ).tap()
            if reachedDestination() { return true }
        }
        return false
    }

    /// Runs Dynamic Type audit with a deliberately exact compatibility ledger
    /// for the Xcode 26 SwiftUI synthesized-node false positives. Any changed
    /// description, element type, identifier, duplicate, new, or missing issue
    /// fails the test; all other audit types remain unsuppressed.
    func assertDynamicTypeAccessibilitySupport(
        expectedCompatibilityIssues: [DynamicTypeAuditIssue] = [],
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let priorContinueAfterFailure = continueAfterFailure
        continueAfterFailure = true
        defer { continueAfterFailure = priorContinueAfterFailure }

        var observed: [DynamicTypeAuditIssue] = []
        do {
            try app.performAccessibilityAudit(for: .dynamicType) { issue in
                guard
                    issue.auditType == .dynamicType,
                    issue.compactDescription == DynamicTypeAuditIssue.compactDescription,
                    issue.detailedDescription == DynamicTypeAuditIssue.detailedDescription,
                    let element = issue.element,
                    let expected = expectedCompatibilityIssues.first(where: {
                        $0.identifier == element.identifier && $0.elementType == element.elementType
                    })
                else {
                    return false
                }
                observed.append(expected)
                return true
            }
        } catch {
            XCTFail("Dynamic Type accessibility audit reported issues: \(error)", file: file, line: line)
            return
        }

        XCTAssertEqual(
            observed.sorted(),
            expectedCompatibilityIssues.sorted(),
            "Dynamic Type compatibility ledger drifted. This only permits the documented Xcode 26 SwiftUI synthesized-node false positives.",
            file: file,
            line: line
        )
    }

    struct DynamicTypeAuditIssue: Hashable, Comparable {
        static let compactDescription = "Dynamic Type font sizes are partially unsupported"
        static let detailedDescription = "User will not be able to change the font size of this SwiftUI.AccessibilityNode"

        let identifier: String
        let elementType: XCUIElement.ElementType

        static func < (lhs: Self, rhs: Self) -> Bool {
            (lhs.identifier, lhs.elementType.rawValue) < (rhs.identifier, rhs.elementType.rawValue)
        }

        static func staticText(_ identifier: String) -> Self {
            Self(identifier: identifier, elementType: .staticText)
        }

        static func button(_ identifier: String) -> Self {
            Self(identifier: identifier, elementType: .button)
        }
    }

    /// Audit the complement of `.dynamicType` after a clean screen reacquisition.
    /// Together with `assertDynamicTypeAccessibilitySupport`, this is exactly
    /// `.all`; neither phase installs an issue handler or suppresses a finding.
    func assertNoNonDynamicTypeAccessibilityIssues(
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let priorContinueAfterFailure = continueAfterFailure
        continueAfterFailure = true
        defer { continueAfterFailure = priorContinueAfterFailure }

        do {
            try app.performAccessibilityAudit(for: .all.subtracting(.dynamicType))
        } catch {
            XCTFail("Accessibility audit reported issues: \(error)", file: file, line: line)
        }
    }
}
