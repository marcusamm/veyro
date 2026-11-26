import XCTest

final class MailboxUITests: XCTestCase {
    @MainActor
    private func requireHittable(_ element: XCUIElement, in app: XCUIApplication,
                                 file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(element.waitForExistence(timeout: 10), app.debugDescription, file: file, line: line)
        let canTap = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [canTap], timeout: 10), .completed,
                       app.debugDescription, file: file, line: line)
    }

    @MainActor
    func testLoginReadAndReplyToFixtureMessage() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-VeyroMailUITestFixture", "-AppleLanguages", "(da)", "-AppleLocale", "da_DK"]
        app.launch()

        let address = app.textFields["Mailadresse"]
        requireHittable(address, in: app)
        address.tap()
        address.typeText("ida@kontor.example")
        let password = app.secureTextFields["Adgangskode"]
        requireHittable(password, in: app)
        password.tap()
        password.typeText("postkasse\n")

        let row = app.buttons["mail-row-41.7"]
        requireHittable(row, in: app)
        let screenshot = XCTAttachment(data: app.screenshot().pngRepresentation, uniformTypeIdentifier: "public.png")
        screenshot.name = "VeyroMail-Indbakke"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        row.tap()

        let fullText = "Har du tid til at se på planen? Vi mødes tirsdag klokken ti."
        let detail = app.descendants(matching: .any).matching(
            NSPredicate(format: "label == %@ OR value == %@", fullText, fullText)
        ).firstMatch
        XCTAssertTrue(detail.waitForExistence(timeout: 10), app.debugDescription)
        let reply = app.buttons.matching(
            NSPredicate(format: "identifier == %@ OR label == %@", "reader-reply", "Svar")
        ).firstMatch
        requireHittable(reply, in: app)
        reply.tap()
        let send = app.buttons["compose-send"]
        XCTAssertTrue(send.waitForExistence(timeout: 10), app.debugDescription)
        let recipient = app.textFields["compose-to"]
        XCTAssertTrue(recipient.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(recipient.value as? String, "nora@kontor.example", app.debugDescription)
        let subject = app.textFields["compose-subject"]
        XCTAssertTrue(subject.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(subject.value as? String, "Re: Plan for tirsdag", app.debugDescription)
        let body = app.descendants(matching: .any).matching(identifier: "compose-body").firstMatch
        requireHittable(body, in: app)
        body.tap()
        body.typeText("Jeg har set planen.")
        requireHittable(send, in: app)
        XCTAssertTrue(send.isEnabled, app.debugDescription)
        send.tap()

        // The fixture confirms delivery only for a reply bound to this original
        // folder and UID, with the expected recipient, text and security headers.
        XCTAssertTrue(app.staticTexts["Mailen er sendt."].waitForExistence(timeout: 10), app.debugDescription)
    }
}
