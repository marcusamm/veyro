import XCTest
@testable import VeyroMail

private final class TestVault: MailSessionVault, @unchecked Sendable {
    private let lock = NSLock()
    private var token: String?
    init(_ token: String? = nil) { self.token = token }
    func load() -> String? { lock.withLock { token } }
    func save(_ value: String) { lock.withLock { token = value } }
    func clear() { lock.withLock { token = nil } }
}

private final class FixtureProtocol: URLProtocol, @unchecked Sendable {
    struct Reply {
        let status: Int
        let data: Data
        let headers: [String: String]
        init(_ status: Int = 200, json: String, headers: [String: String] = [:]) {
            self.status = status
            self.data = Data(json.utf8)
            self.headers = ["Content-Type": "application/json"].merging(headers) { _, value in value }
        }
        init(binary: Data, declaredSize: Int? = nil) {
            self.status = 200
            self.data = binary
            self.headers = ["Content-Type": "application/octet-stream", "Content-Length": String(declaredSize ?? binary.count)]
        }
    }

    typealias Responder = (URLRequest) throws -> Reply
    private static let lock = NSLock()
    private static var responder: Responder?

    static func handle(_ next: Responder?) {
        lock.withLock { responder = next }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            let callback = Self.lock.withLock { Self.responder }
            let responder = try XCTUnwrap(callback)
            let reply = try responder(request)
            let response = try XCTUnwrap(HTTPURLResponse(url: try XCTUnwrap(request.url), statusCode: reply.status,
                                                         httpVersion: "HTTP/1.1", headerFields: reply.headers))
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: reply.data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
    override func stopLoading() {}
}

final class MailAPITests: XCTestCase {
    private let token = "fixture-session-opaque-value"
    private let csrf = "fixture-anti-forgery-value"
    private var sessionBody: String {
        #"{"email":"worker@sample.invalid","csrfToken":"fixture-anti-forgery-value","canManageOrganizations":false}"#
    }

    override func tearDown() {
        FixtureProtocol.handle(nil)
        super.tearDown()
    }

    private func client(_ vault: TestVault) -> MailAPI {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FixtureProtocol.self]
        return MailAPI(vault: vault, configuration: config)
    }

    private func body(_ request: URLRequest) throws -> [String: String] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 2048)
            while true {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count < 0 { throw URLError(.cannotDecodeContentData) }
                if count == 0 { break }
                data.append(contentsOf: buffer.prefix(count))
            }
        }
        return try JSONDecoder().decode([String: String].self, from: data)
    }

    func testLoginRestoresOnlyCookieAndForgetsItOnExpiry() async throws {
        let vault = TestVault()
        let api = client(vault)
        let cookieHeader = "__Host-veyro_session=" + token + "; Secure; HttpOnly; Path=/; SameSite=Lax"
        FixtureProtocol.handle { request in
            XCTAssertEqual(request.url?.absoluteString, "https://mail.veyro.dk/api/login")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Origin"), "https://mail.veyro.dk")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
            XCTAssertNil(request.value(forHTTPHeaderField: "X-CSRF-Token"))
            XCTAssertEqual(try self.body(request), ["email": "worker@sample.invalid", "password": "test-only-password"])
            return .init(json: self.sessionBody, headers: ["Set-Cookie": cookieHeader])
        }
        let session = try await api.login(email: "worker@sample.invalid", password: "test-only-password")
        XCTAssertEqual(session.email, "worker@sample.invalid")
        XCTAssertEqual(vault.load(), token)

        let restored = client(vault)
        FixtureProtocol.handle { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "__Host-veyro_session=" + self.token)
            XCTAssertNil(request.value(forHTTPHeaderField: "Origin"))
            return .init(json: self.sessionBody)
        }
        let restoredSession = try await restored.session()
        XCTAssertEqual(session, restoredSession)

        FixtureProtocol.handle { _ in .init(401, json: #"{"error":"Log ind igen."}"#) }
        do { _ = try await restored.folders(); XCTFail("An expired cookie must be rejected") }
        catch let error as MailAPIError { XCTAssertEqual(error.statusCode, 401) }
        XCTAssertNil(vault.load())
    }

    func testUntrustedCookieRejectedAndRecoveryIsAnonymous() async throws {
        let vault = TestVault()
        let api = client(vault)
        let cookies = [
            "__Host-veyro_session=token; HttpOnly; Path=/",
            "__Host-veyro_session=token; Secure; HttpOnly; Path=/; Domain=veyro.dk",
            "__Host-veyro_session=token; Secure; HttpOnly; Path=/other",
            "other=token; Secure; HttpOnly; Path=/"
        ]
        for cookie in cookies {
            FixtureProtocol.handle { _ in .init(json: self.sessionBody, headers: ["Set-Cookie": cookie]) }
            do { _ = try await api.login(email: "worker@sample.invalid", password: "test"); XCTFail("Unexpected cookie accepted") }
            catch is MailAPIError { XCTAssertNil(vault.load()) }
        }
        let signedIn = client(TestVault(token))
        FixtureProtocol.handle { request in
            XCTAssertEqual(request.url?.path, "/api/recovery/request")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Origin"), "https://mail.veyro.dk")
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
            XCTAssertNil(request.value(forHTTPHeaderField: "X-CSRF-Token"))
            XCTAssertEqual(try self.body(request), ["email": "worker@sample.invalid"])
            return .init(202, json: #"{"ok":true}"#)
        }
        try await signedIn.requestPasswordReset(email: "worker@sample.invalid")
    }

    func testScopedFolderSearchDetailAndActionsMatchTheAPI() async throws {
        let api = client(TestVault(token))
        let summary = #"{"id":"42.17","subject":"Hej","from":"A","to":"B","cc":"","replyTo":"A","senderAddress":"a@sample.invalid","replyAddresses":["a@sample.invalid"],"replyAllTo":["a@sample.invalid"],"replyAllCc":[],"date":"","unread":true,"snippet":"Hej","hasAttachments":true}"#
        let detail = String(summary.dropLast()) + #","text":"Hele teksten","attachments":[{"id":"2.1","name":"kvittering.pdf","size":3}]}"#
        FixtureProtocol.handle { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "__Host-veyro_session=" + self.token)
            switch request.url?.path {
            case "/api/session": return .init(json: self.sessionBody)
            case "/api/folders":
                return .init(json: #"{"folders":[{"id":"SU5CT1g","name":"INBOX","role":"inbox","unread":6}]}"#)
            case "/api/messages":
                let url = try XCTUnwrap(request.url)
                let items = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
                XCTAssertEqual(items.first(where: { $0.name == "cursor" })?.value, "42.18.5")
                XCTAssertEqual(items.first(where: { $0.name == "q" })?.value, "salg+dk & tilbud")
                XCTAssertTrue(url.absoluteString.contains("%2B"))
                return .init(json: #"{"nextCursor":"42.4.3","messages":["# + summary + "]}")
            case "/api/messages/42.17":
                XCTAssertEqual(request.url?.query, "folder=SU5CT1g")
                return .init(json: detail)
            case "/api/messages/42.17/action":
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(request.url?.query, "folder=SU5CT1g")
                XCTAssertEqual(request.value(forHTTPHeaderField: "X-CSRF-Token"), self.csrf)
                XCTAssertEqual(try self.body(request), ["action": "archive"])
                return .init(json: #"{"ok":true}"#)
            default: XCTFail("Unexpected request"); throw URLError(.unsupportedURL)
            }
        }
        let folders = try await api.folders()
        XCTAssertEqual(folders.first?.unread, 6)
        let list = try await api.messages(folder: "SU5CT1g", query: "salg+dk & tilbud", cursor: "42.18.5")
        XCTAssertEqual(list.nextCursor, "42.4.3")
        XCTAssertEqual(list.messages.first?.attachments, [])
        let item = try await api.message(folder: "SU5CT1g", id: "42.17")
        XCTAssertEqual(item.text, "Hele teksten")
        XCTAssertEqual(item.attachments.first?.name, "kvittering.pdf")
        try await api.perform(.archive, folder: "SU5CT1g", id: item.id)
    }

    func testSendRetryReusesKeyAndReplyThreadAndReportsPartialDelivery() async throws {
        let api = client(TestVault(token))
        let key = UUID()
        let draft = MailDraft(to: "a@sample.invalid", cc: "", subject: "Re: Hej", text: "Svar",
                              replyToId: "3.12", replyToFolder: "SU5CT1g")
        FixtureProtocol.handle { request in
            if request.url?.path == "/api/session" { return .init(json: self.sessionBody) }
            XCTAssertEqual(request.url?.path, "/api/send")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), key.uuidString)
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-CSRF-Token"), self.csrf)
            let payload = try self.body(request)
            XCTAssertEqual(payload["replyToId"], "3.12")
            XCTAssertEqual(payload["replyToFolder"], "SU5CT1g")
            throw URLError(.networkConnectionLost)
        }
        do { _ = try await api.send(draft, idempotencyKey: key); XCTFail("Expected delivery uncertainty") } catch {}
        FixtureProtocol.handle { request in
            XCTAssertEqual(request.url?.path, "/api/send")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), key.uuidString)
            return .init(json: #"{"sent":true,"savedCopy":false,"warning":"Kopi mangler","refused":["b@sample.invalid"]}"#)
        }
        let receipt = try await api.send(draft, idempotencyKey: key)
        XCTAssertTrue(receipt.sent)
        XCTAssertFalse(receipt.savedCopy)
        XCTAssertEqual(receipt.refused, ["b@sample.invalid"])
    }

    func testScopedAttachmentAndEarlySizeLimit() async throws {
        let api = client(TestVault(token))
        FixtureProtocol.handle { request in
            XCTAssertEqual(request.url?.absoluteString, "https://mail.veyro.dk/api/messages/42.17/attachments/2.1?folder=SU5CT1g")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "__Host-veyro_session=" + self.token)
            return .init(binary: Data([0, 13, 255]))
        }
        let bytes = try await api.attachment(folder: "SU5CT1g", messageID: "42.17", attachmentID: "2.1")
        XCTAssertEqual(bytes, Data([0, 13, 255]))
        FixtureProtocol.handle { _ in .init(binary: Data(), declaredSize: 32 * 1024 * 1024 + 1) }
        do { _ = try await api.attachment(folder: "SU5CT1g", messageID: "42.17", attachmentID: "2.1"); XCTFail() }
        catch let error as MailAPIError { XCTAssertEqual(error.statusCode, 413) }
        FixtureProtocol.handle { _ in XCTFail("Invalid path reached the transport"); throw URLError(.badURL) }
        do { _ = try await api.attachment(folder: "SU5CT1g", messageID: "42.17", attachmentID: "../login"); XCTFail() }
        catch let error as MailAPIError { XCTAssertEqual(error.statusCode, 400) }
    }

    func testRedirectIsRejectedAndOfflineLogoutClearsCookie() async throws {
        let vault = TestVault(token)
        let api = client(vault)
        FixtureProtocol.handle { request in
            XCTAssertEqual(request.url?.host, "mail.veyro.dk")
            return .init(307, json: "{}", headers: ["Location": "https://sample.invalid/receive"])
        }
        do { _ = try await api.session(); XCTFail("Unexpected redirect") }
        catch let error as MailAPIError { XCTAssertEqual(error.statusCode, 307) }
        let redirectTarget = try XCTUnwrap(URL(string: "https://sample.invalid/receive"))
        let response = try XCTUnwrap(HTTPURLResponse(url: redirectTarget, statusCode: 307, httpVersion: nil, headerFields: nil))
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let task = session.dataTask(with: redirectTarget)
        MailRedirectPolicy().urlSession(session, task: task, willPerformHTTPRedirection: response,
                                        newRequest: URLRequest(url: redirectTarget)) { XCTAssertNil($0) }
        FixtureProtocol.handle { _ in throw URLError(.notConnectedToInternet) }
        do { try await api.logout(); XCTFail() } catch {}
        XCTAssertNil(vault.load())
        do { _ = try await api.session(); XCTFail() }
        catch let error as MailAPIError { XCTAssertEqual(error.statusCode, 401) }
    }
}
