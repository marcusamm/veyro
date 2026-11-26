import SwiftUI
import UniformTypeIdentifiers

struct MessageReader: View {
    @ObservedObject var store: MailStore
    let folder: MailFolder
    let messageID: String
    let canArchive: Bool
    let canTrash: Bool
    let onRead: (MailMessage) -> Void
    let onAction: (MailAction) async throws -> Void
    let compose: (ComposeSeed) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var message: MailMessage?
    @State private var fetchError: String?
    @State private var actionError: String?
    @State private var busy = false
    @State private var activeFile: String?
    @State private var fileError: String?
    @State private var downloadTask: Task<Void, Never>?
    @State private var exportFile: DownloadedAttachment?
    @State private var exportName = ""
    @State private var exporting = false

    var body: some View {
        Group {
            if let message {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        Text(message.displaySubject)
                            .font(.title.bold()).accessibilityAddTraits(.isHeader)
                            .textSelection(.enabled)
                        VStack(alignment: .leading, spacing: 6) {
                            Text(message.from.isEmpty ? "Ukendt afsender" : message.from)
                                .font(.headline).textSelection(.enabled)
                            if !message.to.isEmpty { Text("Til " + message.to).textSelection(.enabled) }
                            if !message.cc.isEmpty { Text("Cc " + message.cc).textSelection(.enabled) }
                            if let date = message.receivedDate {
                                Text(date, format: .dateTime.day().month(.wide).year().hour().minute())
                            }
                        }
                        .font(.subheadline).foregroundStyle(.secondary)
                        Divider()
                        if let text = message.text, !text.isEmpty {
                            Text(verbatim: text)
                                .font(.body).lineSpacing(3).textSelection(.enabled)
                        } else {
                            Text("Mailen har ingen beskedtekst.").foregroundStyle(.secondary)
                        }
                        if !message.attachments.isEmpty { attachments(message.attachments) }
                    }
                    .padding(20).frame(maxWidth: .infinity, alignment: .leading)
                }
                .accessibilityIdentifier("mail-reader")
            } else if let fetchError {
                MailProblem(text: fetchError, retry: load).padding()
            } else {
                ProgressView("Henter mail …")
            }
        }
        .background(Color.mailPaper)
        .navigationTitle(folder.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let message {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            compose(ComposeSeed(draft: message.forwardingDraft(in: folder.id), isForward: true))
                        } label: {
                            Label("Videresend", systemImage: "arrowshape.turn.up.right")
                        }
                        Button { act(.unread) } label: {
                            Label("Markér som ulæst", systemImage: "envelope.badge")
                        }
                        if !message.replyAllTo.isEmpty && (!message.replyAllCc.isEmpty || message.replyAllTo.count > 1) {
                            Button { reply(to: message, all: true) } label: {
                                Label("Svar alle", systemImage: "arrowshape.turn.up.left.2")
                            }
                        }
                    } label: { Label("Flere handlinger", systemImage: "ellipsis.circle") }
                    .disabled(busy)
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if let message {
                VStack(spacing: 0) {
                    Divider()
                    HStack(spacing: 12) {
                        Button { reply(to: message, all: false) } label: {
                            Label("Svar", systemImage: "arrowshape.turn.up.left")
                                .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                        }
                        .accessibilityIdentifier("reader-reply")
                        Spacer()
                        if canArchive {
                            Button { act(.archive) } label: {
                                Label("Arkivér", systemImage: "archivebox").labelStyle(.iconOnly)
                                    .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                            }
                        }
                        if canTrash {
                            Button { act(.trash) } label: {
                                Label("Flyt til papirkurv", systemImage: "trash").labelStyle(.iconOnly)
                                    .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .disabled(busy)
                }
                .background(.bar)
            }
        }
        .task { await load() }
        .alert("Handlingen mislykkedes", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
            Button("Luk", role: .cancel) {}
        } message: { Text(actionError ?? "") }
        .fileExporter(isPresented: $exporting, document: exportFile, contentType: .data, defaultFilename: exportName) { result in
            if case .failure(let error) = result, (error as? CocoaError)?.code != .userCancelled {
                fileError = "Filen kunne ikke gemmes. " + error.localizedDescription
            }
        }
        .onChange(of: exporting) { _, isOpen in
            if !isOpen { exportFile = nil; exportName = "" }
        }
        .onDisappear { downloadTask?.cancel() }
    }

    @ViewBuilder private func attachments(_ files: [MailAttachment]) -> some View {
        Divider()
        Text(files.count == 1 ? "Vedhæftet fil" : "Vedhæftede filer")
            .font(.headline).accessibilityAddTraits(.isHeader)
        ForEach(files) { file in
            if file.size > MailAPI.attachmentLimit {
                VStack(alignment: .leading, spacing: 4) {
                    Label(file.name, systemImage: "doc")
                    Text("Filen er for stor til at hente. Grænsen er 32 MiB.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
            } else {
                Button {
                    downloadTask = Task { await download(file) }
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "doc")
                        VStack(alignment: .leading) {
                            Text(file.name).multilineTextAlignment(.leading).foregroundStyle(.primary)
                            Text(ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if activeFile == file.id { ProgressView() }
                        else { Image(systemName: "square.and.arrow.down") }
                    }
                    .padding(.vertical, 6).contentShape(Rectangle())
                }
                .disabled(activeFile != nil)
                .accessibilityLabel("Gem " + file.name + " i Arkiver")
            }
        }
        if let fileError { Label(fileError, systemImage: "exclamationmark.circle").font(.subheadline) }
    }

    @MainActor private func load() async {
        fetchError = nil
        do {
            let item = try await store.message(folder: folder.id, id: messageID)
            try Task.checkCancellation()
            message = item
            onRead(item)
        } catch {
            if !Task.isCancelled { fetchError = error.localizedDescription }
        }
    }

    private func reply(to message: MailMessage, all: Bool) {
        let subject = message.subject
        let hasPrefix = ["re:", "sv:"].contains { subject.lowercased().hasPrefix($0) }
        let recipients = all ? message.replyAllTo : message.replyAddresses
        let fallback = folder.role == "sent" ? message.to : message.replyTo
        let draft = MailDraft(to: recipients.isEmpty ? fallback : recipients.joined(separator: ", "),
                          cc: all ? message.replyAllCc.joined(separator: ", ") : "",
                          subject: hasPrefix ? subject : "Re: " + subject, replyToId: message.id,
                          replyToFolder: folder.id)
        compose(ComposeSeed(draft: draft))
    }

    private func act(_ action: MailAction) {
        guard !busy else { return }
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do { try await onAction(action); dismiss() }
            catch { actionError = error.localizedDescription }
        }
    }

    @MainActor private func download(_ file: MailAttachment) async {
        guard activeFile == nil else { return }
        activeFile = file.id
        fileError = nil
        defer { activeFile = nil }
        do {
            let bytes = try await store.attachment(folder: folder.id, messageID: messageID, attachmentID: file.id)
            try Task.checkCancellation()
            exportFile = DownloadedAttachment(bytes: bytes)
            exportName = DownloadedAttachment.filename(file.name)
            exporting = true
        } catch {
            if !Task.isCancelled { fileError = error.localizedDescription }
        }
    }
}

private struct DownloadedAttachment: FileDocument {
    static var readableContentTypes: [UTType] { [.data] }
    let bytes: Data

    init(bytes: Data) { self.bytes = bytes }
    init(configuration: ReadConfiguration) throws {
        guard let contents = configuration.file.regularFileContents else { throw CocoaError(.fileReadCorruptFile) }
        bytes = contents
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: bytes)
    }

    static func filename(_ proposed: String) -> String {
        let segments = proposed.components(separatedBy: CharacterSet(charactersIn: "/\\:"))
        let part = (segments.last ?? "").unicodeScalars.filter {
            !CharacterSet.controlCharacters.contains($0) && $0.properties.generalCategory != .format
        }
        let clean = String(String.UnicodeScalarView(part)).trimmingCharacters(in: CharacterSet(charactersIn: ". ").union(.whitespacesAndNewlines))
        var filename = ""
        for character in clean {
            if filename.utf8.count + String(character).utf8.count > 240 { break }
            filename.append(character)
        }
        return filename.isEmpty ? "Vedhæftet fil" : filename
    }
}
