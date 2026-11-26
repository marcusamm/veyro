import SwiftUI

struct ComposeSeed: Identifiable {
    let id = UUID()
    let draft: MailDraft
    var isForward = false
}

struct ComposeMailView: View {
    @ObservedObject var store: MailStore
    let seed: ComposeSeed
    let didSend: (SendReceipt) -> Void

    @Environment(\.dismiss) private var dismiss
    @FocusState private var focus: Field?
    @State private var to: String
    @State private var cc: String
    @State private var subject: String
    @State private var text: String
    @State private var showCc: Bool
    @State private var sending = false
    @State private var confirmDiscard = false
    @State private var errorText: String?
    @State private var lastAttempt: MailDraft?
    @State private var retryKey = UUID()

    private enum Field { case to, cc, subject, body }

    init(store: MailStore, seed: ComposeSeed, didSend: @escaping (SendReceipt) -> Void) {
        self.store = store
        self.seed = seed
        self.didSend = didSend
        _to = State(initialValue: seed.draft.to)
        _cc = State(initialValue: seed.draft.cc)
        _subject = State(initialValue: seed.draft.subject)
        _text = State(initialValue: seed.draft.text)
        _showCc = State(initialValue: !seed.draft.cc.isEmpty)
    }

    private var draft: MailDraft {
        var edited = seed.draft
        edited.to = to.trimmingCharacters(in: .whitespacesAndNewlines)
        edited.cc = cc.trimmingCharacters(in: .whitespacesAndNewlines)
        edited.subject = subject
        edited.text = text
        return edited
    }

    private var title: String {
        if seed.isForward { return "Videresend mail" }
        return seed.draft.replyToId == nil ? "Ny mail" : "Svar"
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        TextField("Til", text: $to)
                            .focused($focus, equals: .to)
                            .accessibilityLabel("Modtager")
                            .accessibilityIdentifier("compose-to")
                        if !showCc {
                            Button("Cc") { showCc = true; focus = .cc }
                                .accessibilityLabel("Tilføj Cc-modtagere")
                        }
                    }
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    if showCc {
                        TextField("Cc", text: $cc)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .focused($focus, equals: .cc)
                    }
                    TextField("Emne", text: $subject)
                        .focused($focus, equals: .subject)
                        .submitLabel(.next).onSubmit { focus = .body }
                        .accessibilityIdentifier("compose-subject")
                }
                Section {
                    TextField("Skriv en besked", text: $text, axis: .vertical)
                        .lineLimit(6...32).focused($focus, equals: .body)
                        .accessibilityLabel("Besked")
                        .accessibilityIdentifier("compose-body")
                    if seed.draft.forwardFiles != nil {
                        Label("De oprindelige vedhæftede filer følger med.", systemImage: "paperclip")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                if let errorText {
                    Section {
                        Label(errorText, systemImage: "exclamationmark.circle")
                    }
                }
            }
            .scrollContentBackground(.hidden).background(Color.mailPaper)
            .scrollDismissesKeyboard(.interactively)
            .disabled(sending)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Annuller") {
                        if draft == seed.draft { dismiss() } else { confirmDiscard = true }
                    }
                    .disabled(sending)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await send() }
                    } label: {
                        if sending { ProgressView() }
                        else { Label("Send", systemImage: "paperplane.fill") }
                    }
                    .accessibilityIdentifier("compose-send")
                    .accessibilityLabel(sending ? "Sender mail" : "Send mail")
                    .disabled(sending || draft.to.isEmpty || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .interactiveDismissDisabled(sending || draft != seed.draft)
            .confirmationDialog("Kassér denne kladde?", isPresented: $confirmDiscard, titleVisibility: .visible) {
                Button("Kassér kladde", role: .destructive) { dismiss() }
                Button("Fortsæt med at skrive", role: .cancel) {}
            }
            .onAppear { focus = to.isEmpty ? .to : .body }
        }
    }

    @MainActor private func send() async {
        guard !sending else { return }
        let outgoing = draft
        if outgoing != lastAttempt {
            lastAttempt = outgoing
            retryKey = UUID()
        }
        sending = true
        errorText = nil
        focus = nil
        defer { sending = false }
        do {
            let receipt = try await store.send(outgoing, idempotencyKey: retryKey)
            guard receipt.sent else {
                errorText = "Afsendelsen kunne ikke bekræftes. Tjek mappen Sendt, før du prøver igen."
                return
            }
            didSend(receipt)
            dismiss()
        } catch {
            let status = (error as? MailAPIError)?.statusCode
            errorText = (status.map { (400..<500).contains($0) } == true)
                ? error.localizedDescription
                : error.localizedDescription + " Tjek mappen Sendt, før du prøver igen."
        }
    }
}
