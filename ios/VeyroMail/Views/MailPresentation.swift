import SwiftUI

extension Color {
    static let mailPaper = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.09, green: 0.09, blue: 0.08, alpha: 1)
            : UIColor(red: 0.98, green: 0.975, blue: 0.96, alpha: 1)
    })
}

extension MailFolder {
    var displayName: String {
        switch role {
        case "inbox": return "Indbakke"
        case "sent": return "Sendt"
        case "drafts": return "Kladder"
        case "archive": return "Arkiv"
        case "junk": return "Spam"
        case "trash": return "Papirkurv"
        default: return name
        }
    }

    var symbol: String {
        switch role {
        case "inbox": return "tray"
        case "sent": return "paperplane"
        case "drafts": return "doc"
        case "archive": return "archivebox"
        case "junk": return "exclamationmark.octagon"
        case "trash": return "trash"
        default: return "folder"
        }
    }

    var sortOrder: Int {
        ["inbox", "sent", "drafts", "archive", "junk", "trash"].firstIndex(of: role) ?? 6
    }
}

extension MailMessage {
    var displaySubject: String {
        subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "(Uden emne)" : subject
    }

    var receivedDate: Date? {
        (try? Date(date, strategy: .iso8601)) ??
            (try? Date(date, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
    }

    func forwardingDraft(in folder: String) -> MailDraft {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "da_DK")
        formatter.dateStyle = .long
        formatter.timeStyle = .short
        let dateLine = receivedDate.map { formatter.string(from: $0) } ?? ""
        var lines = ["", "", "---------- Videresendt mail ----------",
                     "Fra: " + from, "Dato: " + dateLine, "Emne: " + subject, "Til: " + to]
        if !cc.isEmpty { lines.append("Cc: " + cc) }
        lines.append(contentsOf: ["", text ?? ""])
        let hasPrefix = ["fw:", "fwd:", "vs:"].contains { subject.lowercased().hasPrefix($0) }
        return MailDraft(subject: hasPrefix ? subject : "Fwd: " + subject,
                         text: lines.joined(separator: "\n"),
                         forwardFiles: attachments.isEmpty ? nil : .init(id: id, folder: folder))
    }
}

private func displayPerson(_ header: String) -> String {
    let header = header.trimmingCharacters(in: .whitespacesAndNewlines)
    if header.hasSuffix(">"), let start = header.firstIndex(of: "<"),
       !header[header.index(after: start)..<header.index(before: header.endIndex)].contains(">") {
        let name = header[..<start].trimmingCharacters(in: CharacterSet(charactersIn: " \""))
        if !name.isEmpty { return name }
        return String(header[header.index(after: start)..<header.index(before: header.endIndex)])
    }
    return header
}

struct MessageRow: View {
    let message: MailMessage
    let folderRole: String
    @Environment(\.dynamicTypeSize) private var size

    private var correspondent: String {
        let outgoing = folderRole == "sent" || folderRole == "drafts"
        let name = displayPerson(outgoing ? message.to : message.from)
        return outgoing ? (name.isEmpty ? "Ingen modtager" : "Til " + name)
                        : (name.isEmpty ? "Ukendt afsender" : name)
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Circle()
                .fill(message.unread ? Color.accentColor : Color.clear)
                .frame(width: 7, height: 7)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(correspondent)
                        .font(.headline.weight(message.unread ? .bold : .medium))
                        .lineLimit(size.isAccessibilitySize ? nil : 1)
                    Spacer(minLength: 6)
                    if !size.isAccessibilitySize { timestamp }
                }
                Text(message.displaySubject)
                    .font(.subheadline.weight(message.unread ? .semibold : .regular))
                    .lineLimit(size.isAccessibilitySize ? nil : 2)
                if !message.snippet.isEmpty {
                    Text(message.snippet)
                        .font(.subheadline).foregroundStyle(.secondary)
                        .lineLimit(size.isAccessibilitySize ? 3 : 2)
                }
                if size.isAccessibilitySize { timestamp }
            }
            .padding(.vertical, 5)
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(message.unread ? "Ulæst" : "Læst")
        .accessibilityIdentifier("mail-row-" + message.id)
    }

    private var timestamp: some View {
        HStack(spacing: 4) {
            if message.hasAttachments {
                Image(systemName: "paperclip").accessibilityLabel("Vedhæftet fil")
            }
            if let date = message.receivedDate {
                if Calendar.current.isDateInToday(date) {
                    Text(date, format: .dateTime.hour().minute())
                } else {
                    Text(date, format: .dateTime.day().month(.abbreviated))
                }
            }
        }
        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: true, vertical: false)
    }
}

struct MailProblem: View {
    let text: String
    let retry: () async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(text, systemImage: "exclamationmark.circle")
            Button("Prøv igen") { Task { await retry() } }
                .buttonStyle(.bordered)
        }
        .padding(.vertical, 5)
    }
}
