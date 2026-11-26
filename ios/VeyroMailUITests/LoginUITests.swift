import XCTest

final class LoginUITests: XCTestCase {
    @MainActor
    func testSignedOutLoginScreen() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-VeyroMailUITestFixture", "-AppleLanguages", "(da)", "-AppleLocale", "da_DK"]
        app.launch()

        let address = app.textFields["Mailadresse"]
        XCTAssertTrue(address.waitForExistence(timeout: 10))
        XCTAssertTrue(address.isHittable)
        XCTAssertTrue(app.secureTextFields["Adgangskode"].isHittable)
        let login = app.buttons["Log ind"]
        XCTAssertTrue(login.exists)
        XCTAssertFalse(login.isEnabled)
        XCTAssertTrue(app.buttons["Glemt adgangskode?"].exists)

        let screenshot = XCTAttachment(data: app.screenshot().pngRepresentation, uniformTypeIdentifier: "public.png")
        screenshot.name = "VeyroMail-Login"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }
}
