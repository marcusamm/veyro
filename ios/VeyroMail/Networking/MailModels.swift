import Foundation

struct MailSession: Equatable, Sendable {
    let email: String
    let canManageOrganizations: Bool
}

struct MailFolder: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let role: String
    let unread: Int
}

struct MailAttachment: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let size: Int
}

struct MailMessage: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let subject: String
    let from: String
    let to: String
    let cc: String
    let replyTo: String
    let senderAddress: String
    let replyAddresses: [String]
    let replyAllTo: [String]
    let replyAllCc: [String]
    let date: String
    var unread: Bool
    let snippet: String
    let hasAttachments: Bool
    let text: String?
    private let attachmentDetails: [MailAttachment]?

    var attachments: [MailAttachment] { attachmentDetails ?? [] }

    enum CodingKeys: String, CodingKey {
        case id, subject, from, to, cc, replyTo, senderAddress, replyAddresses, replyAllTo, replyAllCc
        case date, unread, snippet, hasAttachments, text
        case attachmentDetails = "attachments"
    }
}

struct MailPage: Decodable, Sendable {
    let messages: [MailMessage]
    let nextCursor: String?
}

struct MailDraft: Encodable, Equatable, Sendable {
    struct SourceFiles: Encodable, Equatable, Sendable {
        let id: String
        let folder: String
    }

    var to = ""
    var cc = ""
    var subject = ""
    var text = ""
    var replyToId: String? = nil
    var replyToFolder: String? = nil
    var forwardFiles: SourceFiles? = nil

    private enum CodingKeys: String, CodingKey { case to, cc, subject, text, replyToId, replyToFolder, forwardFiles }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(to, forKey: .to)
        if !cc.isEmpty { try values.encode(cc, forKey: .cc) }
        try values.encode(subject, forKey: .subject)
        try values.encode(text, forKey: .text)
        try values.encodeIfPresent(replyToId, forKey: .replyToId)
        try values.encodeIfPresent(replyToFolder, forKey: .replyToFolder)
        try values.encodeIfPresent(forwardFiles, forKey: .forwardFiles)
    }
}

enum MailAction: String, Sendable {
    case archive, trash, read, unread
}

struct SendReceipt: Decodable, Sendable {
    let sent: Bool
    let savedCopy: Bool
    let warning: String?
    let refused: [String]?
}

struct MailAPIError: LocalizedError, Sendable {
    let statusCode: Int?
    let message: String
    var errorDescription: String? { message }

    static let signedOut = MailAPIError(statusCode: 401, message: "Log ind for at fortsætte.")
    static let invalidResponse = MailAPIError(statusCode: nil, message: "Mailserveren gav et uventet svar.")
    static let invalidItem = MailAPIError(statusCode: 400, message: "Mappen eller beskeden er ugyldig.")
    static let tooLarge = MailAPIError(statusCode: 413, message: "Filen eller beskeden er for stor.")
}
