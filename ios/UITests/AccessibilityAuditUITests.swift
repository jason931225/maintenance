import XCTest

/// Strict audit suite. The workflow preconditions simulator presentation before
/// each method; app launch never mutates global appearance or content size.
final class AccessibilityAuditUITests: FieldUITestCase {
    func testTodayScreenPassesDynamicTypeAudit() async throws {
        try await prepareToday(.standard)
        assertDynamicTypeAccessibilitySupport(expectedCompatibilityIssues: [
            .staticText(AID.locationConsentTitle),
            .staticText(AID.locationConsentStateLabel),
            .staticText(AID.locationConsentStateValue),
            .staticText(AID.locationConsentCollectionLabel),
            .staticText(AID.locationConsentCollectionValue),
            .button(AID.locationConsentGrantButton),
        ])
    }

    func testWorkOrderDetailPassesDynamicTypeAudit() async throws {
        try await prepareWorkOrderDetail()
        assertDynamicTypeAccessibilitySupport(expectedCompatibilityIssues: [
            .staticText(AID.detailSymptomLabel),
            .staticText(AID.detailSymptomValue),
        ])
    }

    func testMessengerScreenPassesDynamicTypeAudit() async throws {
        try await prepareMessenger(.standard)
        assertDynamicTypeAccessibilitySupport()
    }

    func testLoginScreenPassesDynamicTypeAudit() async throws {
        try await prepareLogin()
        assertDynamicTypeAccessibilitySupport()
    }

    func testTodayScreenPassesNonDynamicAuditStandard() async throws {
        try await prepareToday(.standard)
        assertNoNonDynamicTypeAccessibilityIssues()
    }

    func testTodayScreenPassesNonDynamicAuditLargestDynamicType() async throws {
        try await prepareToday(.largestDynamicType)
        let todayList = app.collectionViews[AID.todayList]
        let workOrderID = try UITestFixture.requiredID(UITestFixture.detailWorkOrderID)
        let workOrder = app.buttons[AID.workOrderRow(workOrderID)]
        XCTAssertNotNil(scrollToElement(workOrder, in: todayList, topSentinel: app.buttons[AID.todayLocationConsentButton], timeout: 30, maxSwipes: 24))
        XCTAssertTrue(positionElementInStableViewport(workOrder, in: todayList))
        assertNoNonDynamicTypeAccessibilityIssues()
    }

    func testTodayScreenPassesNonDynamicAuditDarkMode() async throws {
        try await prepareToday(.darkMode)
        assertNoNonDynamicTypeAccessibilityIssues()
    }

    func testWorkOrderDetailPassesNonDynamicAuditStandard() async throws {
        try await prepareWorkOrderDetail()
        assertNoNonDynamicTypeAccessibilityIssues()
    }

    func testMessengerScreenPassesNonDynamicAuditStandard() async throws {
        try await prepareMessenger(.standard)
        assertNoNonDynamicTypeAccessibilityIssues()
    }

    func testMessengerScreenPassesNonDynamicAuditLargestDynamicType() async throws {
        try await prepareMessenger(.largestDynamicType)
        assertNoNonDynamicTypeAccessibilityIssues()
    }

    func testMessengerScreenPassesNonDynamicAuditDarkMode() async throws {
        try await prepareMessenger(.darkMode)
        assertNoNonDynamicTypeAccessibilityIssues()
    }

    func testLoginScreenPassesNonDynamicAuditStandard() async throws {
        try await prepareLogin()
        assertNoNonDynamicTypeAccessibilityIssues()
    }

    private func prepareToday(_ presentation: Presentation) async throws {
        _ = try await launchApp(presentation)
        waitForAuthenticatedShell()
        XCTAssertTrue(app.collectionViews[AID.todayList].waitForExistence(timeout: 15))
        assertRenderedAppearance(presentation)
    }

    private func prepareWorkOrderDetail() async throws {
        _ = try await launchApp(.standard)
        waitForAuthenticatedShell()
        try openSeededWorkOrder(fixtureKey: UITestFixture.detailWorkOrderID)
    }

    private func prepareMessenger(_ presentation: Presentation) async throws {
        _ = try await launchApp(presentation)
        waitForAuthenticatedShell()
        let messenger = app.collectionViews[AID.messengerTab]
        XCTAssertTrue(tapTab(KO.messengerTitle, destination: messenger))
        XCTAssertTrue(messenger.waitForExistence(timeout: 10))
        let searchField = app.descendants(matching: .any)[AID.messengerSearchField]
        XCTAssertTrue(searchField.waitForExistence(timeout: 10))
        assertRenderedAppearance(presentation)

        // A SwiftUI List materializes only the visible rows. During XCTest's
        // audit sweeps, the upper Messenger sections can leave a message row
        // partially visible at the floating-tab boundary. Every independent
        // audit therefore selects and positions the same exact fixture message.
        let threadID = try UITestFixture.requiredID(UITestFixture.messengerThreadID)
        let thread = app.buttons[AID.messengerThreadRow(threadID)]
        XCTAssertTrue(
            thread.waitForExistence(timeout: 15),
            "Dynamic Type audit must resolve the exact isolated thread."
        )
        thread.tap()

        let messageID = try UITestFixture.requiredID(UITestFixture.messengerInitialMessageID)
        let message = app.staticTexts.matching(
            identifier: AID.messengerMessageRow(messageID)
        ).firstMatch
        XCTAssertTrue(
            materializeMessengerMessage(message, in: messenger),
            "Dynamic Type audit must materialize the exact seeded message row."
        )

        XCTAssertTrue(
            positionElementInStableViewport(message, in: messenger),
            "Accessibility audit must keep the exact seeded message outside system chrome."
        )
    }

    private func materializeMessengerMessage(
        _ message: XCUIElement,
        in container: XCUIElement,
        timeout: TimeInterval = 30,
        maxSwipes: Int = 24
    ) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        guard container.waitForExistence(timeout: min(timeout, 2)) else { return false }

        for _ in 0..<maxSwipes {
            if message.exists, message.isHittable {
                return true
            }
            guard Date() < deadline else { return false }
            container.swipeUp()
        }
        return message.exists && message.isHittable
    }

    /// Settles one exact audit element completely inside the live List viewport
    /// between navigation and floating-tab chrome. Each trailing-gutter drag is
    /// sized from the current geometry and must move the row in the requested
    /// direction; two stalled attempts fail rather than rubber-band forever.
    private func positionElementInStableViewport(
        _ element: XCUIElement,
        in container: XCUIElement,
        timeout: TimeInterval = 20,
        maxDrags: Int = 8
    ) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        let origin = container.coordinate(withNormalizedOffset: .zero)
        let trailingGutterX = max(container.frame.width - 8, 8)
        var stalledAttempts = 0

        for _ in 0..<maxDrags {
            guard Date() < deadline, element.exists, container.exists else { return false }

            let navigationBottom = app.navigationBars.firstMatch.exists
                ? app.navigationBars.firstMatch.frame.maxY
                : container.frame.minY
            let visibleTop = max(container.frame.minY, navigationBottom)
            let tabBarTop = app.tabBars.firstMatch.exists
                ? app.tabBars.firstMatch.frame.minY
                : container.frame.maxY
            let visibleBottom = min(container.frame.maxY, tabBarTop)
            let targetTop = visibleTop
            let targetBottom = visibleBottom - 8
            let frame = element.frame
            guard frame.height <= targetBottom - targetTop else { return false }
            if frame.minY >= targetTop && frame.maxY <= targetBottom {
                return true
            }

            let previousMidY = frame.midY
            let requiredTravel = targetTop - frame.minY
            let maximumTravel = container.frame.height * 0.25
            let travel = min(max(requiredTravel, -maximumTravel), maximumTravel)
            let dragStart = origin.withOffset(
                CGVector(dx: trailingGutterX, dy: container.frame.height * 0.50)
            )
            let dragEnd = origin.withOffset(
                CGVector(dx: trailingGutterX, dy: container.frame.height * 0.50 + travel)
            )
            dragStart.press(forDuration: 0.1, thenDragTo: dragEnd)
            guard element.exists else { return false }

            let actualTravel = element.frame.midY - previousMidY
            if abs(actualTravel) > 1, actualTravel * travel > 0 {
                stalledAttempts = 0
            } else {
                stalledAttempts += 1
                if stalledAttempts >= 2 { return false }
            }
        }
        return false
    }

    private func prepareLogin() async throws {
        _ = try await launchSignedOutApp(.standard)
        XCTAssertTrue(
            app.textFields[AID.loginUserIDField].waitForExistence(timeout: 15),
            "Login field should appear when no session is seeded."
        )
    }
}
