import XCTest
@testable import VeyroMail

final class ForwardingTests: XCTestCase {
    private func source(subject: String, cc: String = "", withFiles: Bool) throws -> MailMessage {
        let detail: [String: Any] = [
            "id": "82.14", "from": "A <a@example.test>", "to": "B <b@example.test>",
            "cc": cc, "subject": subject, "date": "", "text": "Original besked",
            "replyTo": "return@example.test", "senderAddress": "a@example.test",
            "replyAddresses": ["a@example.test"], "replyAllTo": ["a@example.test"], "replyAllCc": [],
            "unread": false, "snippet": "Forhåndsvisning", "hasAttachments": withFiles,
            "attachments": withFiles ? [["id": "2", "name": "bilag.pdf", "size": 128]] : []
        ]
        return try JSONDecoder().decode(MailMessage.self, from: JSONSerialization.data(withJSONObject: detail))
    }

    private func payload(_ draft: MailDraft) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(draft)) as? [String: Any])
    }

    func testForwardKeepsOriginalRecipientsInEditableQuoteAndOnlyReferencesSourceFiles() throws {
        let message = try source(subject: "Prisliste", cc: "C <c@example.test>", withFiles: true)
        var draft = message.forwardingDraft(in: "SU5CT1g")
        XCTAssertEqual(draft.to, "")
        XCTAssertEqual(draft.cc, "")
        XCTAssertEqual(draft.subject, "Fwd: Prisliste")
        XCTAssertEqual(draft.text, "\n\n---------- Videresendt mail ----------\nFra: A <a@example.test>\nDato: \nEmne: Prisliste\nTil: B <b@example.test>\nCc: C <c@example.test>\n\nOriginal besked")

        draft.to = "new@example.test"
        draft.text = "Her er den."
        let encoded = try payload(draft)
        XCTAssertEqual(Set(encoded.keys), ["to", "subject", "text", "forwardFiles"])
        XCTAssertEqual(encoded["to"] as? String, "new@example.test")
        XCTAssertEqual(encoded["text"] as? String, "Her er den.")
        XCTAssertEqual(encoded["forwardFiles"] as? [String: String], ["id": "82.14", "folder": "SU5CT1g"])
    }

    func testTextOnlyForwardPreservesPrefixesAndOmitsSourceAndEmptyCc() throws {
        for subject in ["Fw: Møde", "FWD: Møde", "Vs: Møde"] {
            let message = try source(subject: subject, withFiles: false)
            let draft = message.forwardingDraft(in: "SU5CT1g")
            XCTAssertEqual(draft.subject, subject)
            XCTAssertFalse(draft.text.contains("\nCc:"))
            XCTAssertEqual(Set(try payload(draft).keys), ["to", "subject", "text"])
        }
    }
}
