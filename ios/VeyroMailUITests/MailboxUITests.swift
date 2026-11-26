import XCTest

final class MailboxUITests: XCTestCase {
    @MainActor
    func testLoginReadAndReplyToFixtureMessage() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-VeyroMailUITestFixture", "-AppleLanguages", "(da)", "-AppleLocale", "da_DK"]
        app.launch()

        let address = app.textFields["Mailadresse"]
        XCTAssertTrue(address.waitForExistence(timeout: 10))
        address.tap()
        address.typeText("ida@kontor.example")
        let password = app.secureTextFields["Adgangskode"]
        password.tap()
        password.typeText("postkasse\n")

        let row = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier == %@ OR label CONTAINS %@", "mail-row-41.7", "Plan for tirsdag")
        ).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        let screenshot = XCTAttachment(data: app.screenshot().pngRepresentation, uniformTypeIdentifier: "public.png")
        screenshot.name = "VeyroMail-Indbakke"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        row.tap()

        let reply = app.buttons["reader-reply"]
        XCTAssertTrue(reply.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Har du tid til at se på planen?"].exists)
        let canTapReply = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: reply)
        XCTAssertEqual(XCTWaiter.wait(for: [canTapReply], timeout: 10), .completed, app.debugDescription)
        reply.tap()
        let recipient = app.descendants(matching: .any)["compose-to"]
        XCTAssertTrue(recipient.waitForExistence(timeout: 10))
        XCTAssertEqual(recipient.value as? String, "nora@kontor.example")
        let subject = app.descendants(matching: .any)["compose-subject"]
        XCTAssertEqual(subject.value as? String, "Re: Plan for tirsdag")
        let body = app.descendants(matching: .any)["compose-body"]
        body.tap()
        body.typeText("Jeg har set planen.")
        app.buttons["compose-send"].tap()

        // The fixture confirms delivery only for a reply bound to this original
        // folder and UID, with the expected recipient, text and security headers.
        XCTAssertTrue(app.staticTexts["Mailen er sendt."].waitForExistence(timeout: 10))
    }
}
