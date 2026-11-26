#if DEBUG && targetEnvironment(simulator)
import Foundation

enum SimulatorMailboxFixture {
    static func api() -> MailAPI {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SimulatorMailboxProtocol.self]
        return MailAPI(vault: MemoryVault(), configuration: config)
    }

    private final class MemoryVault: MailSessionVault, @unchecked Sendable {
        private let lock = NSLock()
        private var cookie: String?
        func load() -> String? { lock.withLock { cookie } }
        func save(_ value: String) { lock.withLock { cookie = value } }
        func clear() { lock.withLock { cookie = nil } }
    }
}

private final class SimulatorMailboxProtocol: URLProtocol, @unchecked Sendable {
    private static let address = "ida@kontor.example"
    private static let sender = "nora@kontor.example"
    private static let cookie = "__Host-veyro_session=fixture-mail-session"
    private static let csrf = "fixture-mail-csrf"
    private static let inbox = "SU5CT1g"
    private static let identifier = "41.7"

    // Intercept every request from the injected session, including unexpected URLs.
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let url = request.url else { throw URLError(.badURL) }
            let result = try fixtureResponse()
            let headers = ["Content-Type": "application/json"].merging(result.headers) { _, value in value }
            guard let response = HTTPURLResponse(url: url, statusCode: result.status, httpVersion: "HTTP/1.1",
                                                 headerFields: headers) else { throw URLError(.badServerResponse) }
            let data = try JSONSerialization.data(withJSONObject: result.json)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}

    private struct Reply {
        let json: [String: Any]
        var status = 200
        var headers: [String: String] = [:]
    }

    private func fixtureResponse() throws -> Reply {
        guard let url = request.url, url.scheme == "https", url.host == "mail.veyro.dk" else {
            throw URLError(.unsupportedURL)
        }
        let session: [String: Any] = ["email": Self.address, "csrfToken": Self.csrf, "canManageOrganizations": false]
        if request.httpMethod == "POST" && url.path == "/api/login" {
            let input = try requestFields()
            guard input["email"] == Self.address, input["password"] == "postkasse",
                  request.value(forHTTPHeaderField: "Origin") == "https://mail.veyro.dk" else {
                return Reply(json: ["error": "Kontrollér testlogin."], status: 401)
            }
            return Reply(json: session, headers: ["Set-Cookie": Self.cookie + "; Secure; HttpOnly; Path=/; SameSite=Lax"])
        }
        guard request.value(forHTTPHeaderField: "Cookie") == Self.cookie else {
            return Reply(json: ["error": "Log ind igen."], status: 401)
        }
        let summary: [String: Any] = [
            "id": Self.identifier, "subject": "Plan for tirsdag", "from": "Nora <" + Self.sender + ">",
            "to": Self.address, "cc": "", "replyTo": Self.sender, "senderAddress": Self.sender,
            "replyAddresses": [Self.sender], "replyAllTo": [Self.sender], "replyAllCc": [String](),
            "date": "2026-11-24T10:00:00+01:00", "unread": true, "snippet": "Har du tid til at se på planen?",
            "hasAttachments": false
        ]
        switch (request.httpMethod, url.path) {
        case ("GET", "/api/session"):
            return Reply(json: session)
        case ("GET", "/api/folders"):
            return Reply(json: ["folders": [["id": Self.inbox, "name": "INBOX", "role": "inbox", "unread": 1]]])
        case ("GET", "/api/messages") where url.query == "folder=" + Self.inbox:
            return Reply(json: ["messages": [summary], "nextCursor": NSNull()])
        case ("GET", "/api/messages/" + Self.identifier) where url.query == "folder=" + Self.inbox:
            var detail = summary
            detail["unread"] = false
            detail["text"] = "Har du tid til at se på planen?"
            detail["attachments"] = []
            return Reply(json: detail)
        case ("POST", "/api/send"):
            let input = try requestFields()
            guard let key = request.value(forHTTPHeaderField: "Idempotency-Key"), UUID(uuidString: key) != nil,
                  request.value(forHTTPHeaderField: "X-CSRF-Token") == Self.csrf,
                  request.value(forHTTPHeaderField: "Origin") == "https://mail.veyro.dk",
                  input["replyToId"] == Self.identifier, input["replyToFolder"] == Self.inbox,
                  input["to"] == Self.sender, input["subject"] == "Re: Plan for tirsdag",
                  input["text"] == "Jeg har set planen." else {
                return Reply(json: ["error": "Testsvaret passer ikke til den åbnede mail."], status: 422)
            }
            return Reply(json: ["sent": true, "savedCopy": true])
        default:
            return Reply(json: ["error": "Ukendt testforespørgsel."], status: 404)
        }
    }

    private func requestFields() throws -> [String: String] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 1024)
            while data.count < 4096 {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count < 0 { throw URLError(.cannotDecodeContentData) }
                if count == 0 { break }
                data.append(contentsOf: buffer.prefix(count))
            }
        }
        return try JSONDecoder().decode([String: String].self, from: data)
    }
}
#endif
