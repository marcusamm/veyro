import Foundation
import Combine

@MainActor
final class MailStore: ObservableObject {
    enum Phase {
        case starting, signedOut, signedIn, signingOut, restoreFailed
    }

    @Published private(set) var phase: Phase = .starting
    @Published private(set) var email = ""
    @Published private(set) var canManageOrganizations = false
    @Published private(set) var isSigningIn = false
    @Published private(set) var authMessage: String?
    private let api: MailAPI
    private var accountRevision = UUID()

    init(api: MailAPI = MailAPI()) { self.api = api }

    func restore() async {
        guard phase == .starting || phase == .restoreFailed else { return }
        phase = .starting
        let revision = accountRevision
        do {
            let session = try await api.session()
            guard revision == accountRevision else { return }
            enter(session)
        } catch {
            guard revision == accountRevision else { return }
            if (error as? MailAPIError)?.statusCode == 401 {
                leave()
            } else {
                authMessage = error.localizedDescription
                phase = .restoreFailed
            }
        }
    }

    func login(email: String, password: String) async {
        guard phase == .signedOut, !isSigningIn else { return }
        isSigningIn = true
        authMessage = nil
        defer { isSigningIn = false }
        do {
            enter(try await api.login(email: email.trimmingCharacters(in: .whitespacesAndNewlines), password: password))
        } catch {
            authMessage = error.localizedDescription
        }
    }

    private func enter(_ session: MailSession) {
        accountRevision = UUID()
        email = session.email
        canManageOrganizations = session.canManageOrganizations
        authMessage = nil
        phase = .signedIn
    }

    private func leave(_ message: String? = nil) {
        accountRevision = UUID()
        email = ""
        canManageOrganizations = false
        authMessage = message
        phase = .signedOut
    }

    func logout() async {
        guard phase == .signedIn || phase == .restoreFailed else { return }
        accountRevision = UUID()
        phase = .signingOut
        do {
            try await api.logout()
            leave()
        } catch {
            leave((error as? MailAPIError)?.statusCode == 401 ? nil : error.localizedDescription)
        }
    }

    func requestPasswordReset(email: String) async throws {
        try await api.requestPasswordReset(email: email.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private func authenticated<T>(_ operation: () async throws -> T) async throws -> T {
        guard phase == .signedIn else { throw CancellationError() }
        let revision = accountRevision
        do {
            let result = try await operation()
            guard revision == accountRevision else { throw CancellationError() }
            return result
        } catch {
            guard revision == accountRevision else { throw CancellationError() }
            if (error as? MailAPIError)?.statusCode == 401 {
                leave("Din session er udløbet. Log ind igen.")
            }
            throw error
        }
    }

    func folders() async throws -> [MailFolder] {
        try await authenticated { try await api.folders() }
    }

    func messages(folder: String, query: String, cursor: String?) async throws -> MailPage {
        try await authenticated { try await api.messages(folder: folder, query: query, cursor: cursor) }
    }

    func message(folder: String, id: String) async throws -> MailMessage {
        try await authenticated { try await api.message(folder: folder, id: id) }
    }

    func apply(_ action: MailAction, folder: String, id: String) async throws {
        try await authenticated { try await api.perform(action, folder: folder, id: id) }
    }

    func send(_ draft: MailDraft, idempotencyKey: UUID) async throws -> SendReceipt {
        try await authenticated { try await api.send(draft, idempotencyKey: idempotencyKey) }
    }

    func attachment(folder: String, messageID: String, attachmentID: String) async throws -> Data {
        try await authenticated {
            try await api.attachment(folder: folder, messageID: messageID, attachmentID: attachmentID)
        }
    }
}
