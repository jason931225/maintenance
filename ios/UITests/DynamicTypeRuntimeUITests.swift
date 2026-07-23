import XCTest

/// Runtime geometry contracts complement XCTest's Dynamic Type audit. They use
/// the shell-preconditioned simulator sizes and prove the adaptive layouts that
/// Xcode 26's synthesized SwiftUI audit nodes cannot represent faithfully.
final class DynamicTypeRuntimeUITests: FieldUITestCase {
    func testLargeDynamicTypeRuntimeContract() async throws {
        _ = try await launchApp(.standard)
        waitForAuthenticatedShell()

        let list = app.collectionViews[AID.todayList]
        XCTAssertTrue(list.waitForExistence(timeout: 15))
        let consentTitle = app.staticTexts[AID.locationConsentTitle]
        XCTAssertTrue(consentTitle.waitForExistence(timeout: 15), "Large Dynamic Type keeps consent inline.")
        XCTAssertFalse(app.buttons[AID.todayLocationConsentButton].exists, "Large Dynamic Type must not move consent to toolbar.")

        let (body, timestamp, container) = try await openSeededMessengerMessage()
        XCTAssertTrue(body.isHittable)
        XCTAssertTrue(timestamp.isHittable)
        XCTAssertTrue(sameHorizontalBand(body.frame, timestamp.frame), "Large Dynamic Type keeps message body and timestamp in one horizontal band.")
        XCTAssertFalse(body.frame.intersects(timestamp.frame), "Message body and timestamp must not overlap.")
        XCTAssertTrue(visible(body.frame, in: container.frame))
        XCTAssertTrue(visible(timestamp.frame, in: container.frame))
    }

    func testAccessibilityExtraExtraExtraLargeRuntimeContract() async throws {
        _ = try await launchApp(.largestDynamicType)
        waitForAuthenticatedShell()

        XCTAssertFalse(app.staticTexts[AID.locationConsentTitle].exists, "Accessibility size must move inline consent into the sheet.")
        let openConsent = app.buttons[AID.todayLocationConsentButton]
        XCTAssertTrue(openConsent.waitForExistence(timeout: 15), "Accessibility size must expose the consent toolbar action.")
        openConsent.tap()

        let close = app.buttons[AID.todayLocationConsentCloseButton]
        XCTAssertTrue(close.waitForExistence(timeout: 10), "Consent sheet must open.")
        let sheet = app.collectionViews[AID.todayLocationConsentSheet]
        XCTAssertTrue(sheet.waitForExistence(timeout: 10), "Consent sheet content must expose its stable container.")

        let nodes = [
            app.staticTexts[AID.locationConsentTitle],
            app.staticTexts[AID.locationConsentStateLabel],
            app.staticTexts[AID.locationConsentStateValue],
            app.staticTexts[AID.locationConsentCollectionLabel],
            app.staticTexts[AID.locationConsentCollectionValue],
            app.buttons[AID.locationConsentGrantButton],
        ]
        for node in nodes {
            XCTAssertTrue(node.waitForExistence(timeout: 10), "Accessibility-size consent node is missing: \(node.identifier)")
            XCTAssertTrue(node.isHittable, "Accessibility-size consent node is not hittable: \(node.identifier)")
            XCTAssertTrue(visible(node.frame, in: sheet.frame), "Consent node is outside the visible sheet: \(node.identifier)")
        }
        XCTAssertGreaterThanOrEqual(app.buttons[AID.locationConsentGrantButton].frame.height, 44)

        close.tap()
        XCTAssertTrue(close.waitForNonExistence(timeout: 10), "Consent sheet must dismiss before changing tabs.")
        let (body, timestamp, container) = try await openSeededMessengerMessage()
        XCTAssertTrue(body.isHittable)
        XCTAssertTrue(timestamp.isHittable)
        XCTAssertGreaterThan(timestamp.frame.minY, body.frame.maxY, "Accessibility size must vertically separate timestamp from body.")
        XCTAssertTrue(visible(body.frame, in: container.frame))
        XCTAssertTrue(visible(timestamp.frame, in: container.frame))
        XCTAssertClearOfChrome(body.frame)
        XCTAssertClearOfChrome(timestamp.frame)
    }

    private func openSeededMessengerMessage() async throws -> (XCUIElement, XCUIElement, XCUIElement) {
        let messenger = app.collectionViews[AID.messengerTab]
        XCTAssertTrue(tapTab(KO.messengerTitle, destination: messenger))
        XCTAssertTrue(messenger.waitForExistence(timeout: 10))
        let threadID = try UITestFixture.requiredID(UITestFixture.messengerThreadID)
        let thread = app.buttons[AID.messengerThreadRow(threadID)]
        XCTAssertTrue(thread.waitForExistence(timeout: 15))
        thread.tap()

        let messageID = try UITestFixture.requiredID(UITestFixture.messengerInitialMessageID)
        let body = app.staticTexts[AID.messengerMessageRow(messageID)]
        let timestamp = app.staticTexts[AID.messengerMessageTimestamp(messageID)]
        XCTAssertTrue(
            scrollToMessengerMessage(body: body, timestamp: timestamp, in: messenger),
            "The exact seeded message row must materialize within the bounded Messenger viewport scan."
        )
        return (body, timestamp, messenger)
    }

    private func scrollToMessengerMessage(
        body: XCUIElement,
        timestamp: XCUIElement,
        in container: XCUIElement,
        timeout: TimeInterval = 30,
        maxSwipes: Int = 24
    ) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        guard container.waitForExistence(timeout: min(timeout, 2)) else { return false }

        for _ in 0..<maxSwipes {
            if body.exists, body.isHittable, timestamp.exists, timestamp.isHittable {
                return true
            }
            guard Date() < deadline else { return false }
            container.swipeUp()
        }
        return body.exists && body.isHittable && timestamp.exists && timestamp.isHittable
    }

    private func sameHorizontalBand(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
        abs(lhs.midY - rhs.midY) <= max(lhs.height, rhs.height) * 0.75
    }

    private func visible(_ frame: CGRect, in container: CGRect) -> Bool {
        frame.isEmpty == false && container.contains(frame)
    }

    private func XCTAssertClearOfChrome(_ frame: CGRect, file: StaticString = #filePath, line: UInt = #line) {
        let navigationBottom = app.navigationBars.firstMatch.exists ? app.navigationBars.firstMatch.frame.maxY : 0
        let tabTop = app.tabBars.firstMatch.exists ? app.tabBars.firstMatch.frame.minY : app.frame.maxY
        XCTAssertGreaterThanOrEqual(frame.minY, navigationBottom, file: file, line: line)
        XCTAssertLessThanOrEqual(frame.maxY, tabTop, file: file, line: line)
    }
}
