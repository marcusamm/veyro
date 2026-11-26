import Foundation

protocol MailSessionVault: Sendable {
    func load() throws -> String?
    func save(_ value: String) throws
    func clear() throws
}

final class MailRedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

actor MailAPI {
    private static let origin = "https://mail.veyro.dk"
    private static let cookieName = "__Host-veyro_session"
    static let attachmentLimit = 32 * 1024 * 1024

    private let transport: URLSession
    private let vault: any MailSessionVault
    private var cookie: String?
    private var loadedCookie = false
    private var csrf: String?
    private var generation = UUID()

    init(vault: any MailSessionVault = SessionVault(), configuration: URLSessionConfiguration = .ephemeral) {
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 45
        configuration.timeoutIntervalForResource = 120
        self.vault = vault
        self.transport = URLSession(configuration: configuration, delegate: MailRedirectPolicy(), delegateQueue: nil)
    }

    private struct SessionResponse: Decodable {
        let email: String
        let csrfToken: String
        let canManageOrganizations: Bool
    }

    private struct FolderResponse: Decodable { let folders: [MailFolder] }
    private struct StatusResponse: Decodable { let ok: Bool }
    private struct ErrorResponse: Decodable { let error: String }

    func login(email: String, password: String) async throws -> MailSession {
        let previousCookie = try sessionCookie()
        try forget()
        let stamp = generation
        let body = try JSONEncoder().encode(["email": email, "password": password])
        let req = try request(path: "/api/login", body: body, cookie: previousCookie)
        let (data, response) = try await exchange(req)
        guard generation == stamp else { throw CancellationError() }
        let result = try decode(SessionResponse.self, from: data)
        guard result.email == email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              Self.isToken(result.csrfToken),
              let token = Self.sessionToken(from: response) else { throw MailAPIError.invalidResponse }
        try vault.save(token)
        cookie = token
        csrf = result.csrfToken
        return MailSession(email: result.email, canManageOrganizations: result.canManageOrganizations)
    }

    func session() async throws -> MailSession {
        guard let token = try sessionCookie() else { throw MailAPIError.signedOut }
        let stamp = generation
        let req = try request(path: "/api/session", cookie: token)
        let (data, _) = try await exchange(req)
        guard generation == stamp else { throw CancellationError() }
        let result = try decode(SessionResponse.self, from: data)
        guard !result.email.isEmpty, Self.isToken(result.csrfToken) else { throw MailAPIError.invalidResponse }
        csrf = result.csrfToken
        return MailSession(email: result.email, canManageOrganizations: result.canManageOrganizations)
    }

    func logout() async throws {
        let token: String?
        do { token = try sessionCookie() }
        catch { try forget(); throw error }
        let currentCSRF = csrf
        // Forget locally before any network suspension, including when offline.
        try forget()
        guard let token else { return }
        var logoutCSRF = currentCSRF
        if logoutCSRF == nil {
            let req = try request(path: "/api/session", cookie: token)
            let (data, _) = try await exchange(req)
            logoutCSRF = try decode(SessionResponse.self, from: data).csrfToken
        }
        guard let logoutCSRF, Self.isToken(logoutCSRF) else { throw MailAPIError.invalidResponse }
        let req = try request(path: "/api/logout", body: Data("{}".utf8), cookie: token, csrf: logoutCSRF)
        let (data, _) = try await exchange(req)
        try assertOK(data)
    }

    func requestPasswordReset(email: String) async throws {
        let body = try JSONEncoder().encode(["email": email])
        let req = try request(path: "/api/recovery/request", body: body)
        let (data, _) = try await exchange(req)
        try assertOK(data)
    }

    func folders() async throws -> [MailFolder] {
        let data = try await authenticated(path: "/api/folders")
        return try decode(FolderResponse.self, from: data).folders
    }

    func messages(folder: String, query: String = "", cursor: String? = nil) async throws -> MailPage {
        var items = try Self.folderQuery(folder)
        if !query.isEmpty { items.append(URLQueryItem(name: "q", value: query)) }
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        let data = try await authenticated(path: "/api/messages", query: items)
        return try decode(MailPage.self, from: data)
    }

    func message(folder: String, id: String) async throws -> MailMessage {
        let data = try await authenticated(path: Self.messagePath(id), query: Self.folderQuery(folder))
        let message = try decode(MailMessage.self, from: data)
        guard message.id == id, message.text != nil else { throw MailAPIError.invalidResponse }
        return message
    }

    func perform(_ action: MailAction, folder: String, id: String) async throws {
        let body = try JSONEncoder().encode(["action": action.rawValue])
        let data = try await authenticated(path: Self.messagePath(id) + "/action", query: Self.folderQuery(folder), body: body)
        try assertOK(data)
    }

    func send(_ draft: MailDraft, idempotencyKey: UUID) async throws -> SendReceipt {
        if let replyID = draft.replyToId, let folder = draft.replyToFolder {
            _ = try Self.messagePath(replyID)
            _ = try Self.folderQuery(folder)
        } else if draft.replyToId != nil || draft.replyToFolder != nil {
            throw MailAPIError.invalidItem
        }
        if let source = draft.forwardFiles {
            guard draft.replyToId == nil else { throw MailAPIError.invalidItem }
            _ = try Self.messagePath(source.id)
            _ = try Self.folderQuery(source.folder)
        }
        let body = try JSONEncoder().encode(draft)
        let data = try await authenticated(path: "/api/send", body: body, key: idempotencyKey)
        let receipt = try decode(SendReceipt.self, from: data)
        guard receipt.sent else { throw MailAPIError.invalidResponse }
        return receipt
    }

    func attachment(folder: String, messageID: String, attachmentID: String) async throws -> Data {
        guard attachmentID.count <= 250, attachmentID.range(of: #"^[1-9][0-9]*(\.[1-9][0-9]*)*\z"#,
                                                             options: .regularExpression) != nil else {
            throw MailAPIError.invalidItem
        }
        let path = try Self.messagePath(messageID) + "/attachments/" + attachmentID
        guard let token = try sessionCookie() else { throw MailAPIError.signedOut }
        var req = try request(path: path, query: Self.folderQuery(folder), cookie: token)
        req.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
        let stamp = generation
        let (bytes, rawResponse) = try await transport.bytes(for: req)
        defer { bytes.task.cancel() }
        guard generation == stamp else { throw CancellationError() }
        guard let response = rawResponse as? HTTPURLResponse, response.url == req.url else {
            throw MailAPIError.invalidResponse
        }
        guard (200..<300).contains(response.statusCode) else {
            throw try responseError(response, data: Data(), request: req)
        }
        guard response.mimeType == "application/octet-stream" else { throw MailAPIError.invalidResponse }
        guard response.expectedContentLength <= Self.attachmentLimit else { throw MailAPIError.tooLarge }
        var data = Data()
        if response.expectedContentLength > 0 { data.reserveCapacity(Int(response.expectedContentLength)) }
        for try await byte in bytes {
            guard data.count < Self.attachmentLimit else { throw MailAPIError.tooLarge }
            data.append(byte)
        }
        guard generation == stamp else { throw CancellationError() }
        return data
    }

    private func sessionCookie() throws -> String? {
        if !loadedCookie {
            let saved = try vault.load()
            if let saved, !Self.isToken(saved) { try forget(); return nil }
            cookie = saved
            loadedCookie = true
        }
        return cookie
    }

    private func forget() throws {
        generation = UUID()
        cookie = nil
        csrf = nil
        loadedCookie = true
        try vault.clear()
    }

    private func authenticated(path: String, query: [URLQueryItem] = [], body: Data? = nil,
                               key: UUID? = nil) async throws -> Data {
        let stamp = generation
        if body != nil && csrf == nil { _ = try await session() }
        guard generation == stamp else { throw CancellationError() }
        guard let token = try sessionCookie() else { throw MailAPIError.signedOut }
        let req = try request(path: path, query: query, body: body, cookie: token, csrf: csrf, key: key)
        return try await exchange(req).0
    }

    private func request(path: String, query: [URLQueryItem] = [], body: Data? = nil,
                         cookie: String? = nil, csrf: String? = nil, key: UUID? = nil) throws -> URLRequest {
        var parts = URLComponents()
        parts.scheme = "https"
        parts.host = "mail.veyro.dk"
        parts.path = path
        if !query.isEmpty {
            parts.queryItems = query
            // Flask interprets a literal plus in a query as a space.
            parts.percentEncodedQuery = parts.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        }
        guard let url = parts.url else { throw MailAPIError.invalidItem }
        var req = URLRequest(url: url)
        req.httpShouldHandleCookies = false
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let cookie { req.setValue(Self.cookieName + "=" + cookie, forHTTPHeaderField: "Cookie") }
        if let body {
            guard body.count <= 256 * 1024 else { throw MailAPIError.tooLarge }
            req.httpMethod = "POST"
            req.httpBody = body
            req.setValue(Self.origin, forHTTPHeaderField: "Origin")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if let csrf { req.setValue(csrf, forHTTPHeaderField: "X-CSRF-Token") }
            if let key { req.setValue(key.uuidString, forHTTPHeaderField: "Idempotency-Key") }
        }
        return req
    }

    private func exchange(_ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let stamp = generation
        let (data, rawResponse) = try await transport.data(for: req)
        guard generation == stamp else { throw CancellationError() }
        guard let response = rawResponse as? HTTPURLResponse, response.url == req.url else {
            throw MailAPIError.invalidResponse
        }
        guard (200..<300).contains(response.statusCode) else { throw try responseError(response, data: data, request: req) }
        guard response.mimeType == "application/json" else { throw MailAPIError.invalidResponse }
        return (data, response)
    }

    private func responseError(_ response: HTTPURLResponse, data: Data, request: URLRequest) throws -> MailAPIError {
        if response.statusCode == 401, let cookie,
           request.value(forHTTPHeaderField: "Cookie") == Self.cookieName + "=" + cookie {
            try forget()
        }
        if let error = try? JSONDecoder().decode(ErrorResponse.self, from: data), !error.error.isEmpty {
            return MailAPIError(statusCode: response.statusCode, message: error.error)
        }
        return MailAPIError(statusCode: response.statusCode, message: "Mailserveren kunne ikke fuldføre anmodningen.")
    }

    private func assertOK(_ data: Data) throws {
        guard try decode(StatusResponse.self, from: data).ok else { throw MailAPIError.invalidResponse }
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do { return try JSONDecoder().decode(type, from: data) }
        catch { throw MailAPIError.invalidResponse }
    }

    private static func isToken(_ value: String) -> Bool {
        value.range(of: #"^[A-Za-z0-9_-]{1,256}\z"#, options: .regularExpression) != nil
    }

    private static func sessionToken(from response: HTTPURLResponse) -> String? {
        guard let raw = response.value(forHTTPHeaderField: "Set-Cookie") else { return nil }
        let fields = raw.components(separatedBy: ";").map { $0.trimmingCharacters(in: .whitespaces) }
        guard let first = fields.first, first.hasPrefix(cookieName + "=") else { return nil }
        let attributes = Set(fields.dropFirst().map { $0.lowercased() })
        guard attributes.contains("secure"), attributes.contains("httponly"), attributes.contains("path=/"),
              !attributes.contains(where: { $0.hasPrefix("domain=") }) else { return nil }
        let token = String(first.dropFirst(cookieName.count + 1))
        return isToken(token) ? token : nil
    }

    private static func folderQuery(_ folder: String) throws -> [URLQueryItem] {
        guard folder.range(of: #"^[A-Za-z0-9_-]{1,1600}\z"#, options: .regularExpression) != nil else {
            throw MailAPIError.invalidItem
        }
        return [URLQueryItem(name: "folder", value: folder)]
    }

    private static func messagePath(_ id: String) throws -> String {
        guard id.range(of: #"^[0-9]{1,10}\.[0-9]{1,10}\z"#, options: .regularExpression) != nil else {
            throw MailAPIError.invalidItem
        }
        return "/api/messages/" + id
    }
}
