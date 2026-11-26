import SwiftUI

private struct MailLocation: Hashable {
    let folder: String
    let id: String
}

private struct MailSearch: Equatable {
    let folder: String
    let query: String
}

struct MailboxView: View {
    @ObservedObject var store: MailStore
    @State private var folders: [MailFolder] = []
    @State private var folderID = ""
    @State private var search = ""
    @State private var messages: [MailMessage] = []
    @State private var cursor: String?
    @State private var displayed: MailSearch?
    @State private var listRequest: UUID?
    @State private var folderRequest: UUID?
    @State private var receivedFolders = false
    @State private var folderError: String?
    @State private var listError: String?
    @State private var failedNextPage = false
    @State private var mutating = Set<MailLocation>()
    @State private var compose: ComposeSeed?
    @State private var notice: String?

    private var folder: MailFolder? { folders.first { $0.id == folderID } }
    private var key: MailSearch {
        MailSearch(folder: folderID, query: search.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    var body: some View {
        NavigationStack {
            List {
                if let folderError { MailProblem(text: folderError, retry: loadFolders) }
                if let listError {
                    MailProblem(text: listError) { await fetch(key, more: failedNextPage) }
                }
                if displayed == key && !messages.isEmpty {
                    ForEach(messages) { item in
                        let location = MailLocation(folder: folderID, id: item.id)
                        NavigationLink(value: location) {
                            MessageRow(message: item, folderRole: folder?.role ?? "")
                        }
                        .swipeActions(edge: .leading, allowsFullSwipe: false) {
                            Button {
                                change(item.unread ? .read : .unread, at: location)
                            } label: {
                                Label(item.unread ? "Læst" : "Ulæst", systemImage: item.unread ? "envelope.open" : "envelope.badge")
                            }
                            .tint(.accentColor)
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            if canMove(from: folder, to: "trash") {
                                Button(role: .destructive) { change(.trash, at: location) } label: {
                                    Label("Papirkurv", systemImage: "trash")
                                }
                            }
                            if canMove(from: folder, to: "archive") {
                                Button { change(.archive, at: location) } label: {
                                    Label("Arkivér", systemImage: "archivebox")
                                }
                                .tint(.indigo)
                            }
                        }
                        .disabled(mutating.contains(location))
                        .listRowBackground(Color.mailPaper)
                    }
                }
                if listRequest != nil || (!receivedFolders && folderError == nil) {
                    HStack { Spacer(); ProgressView("Henter postkasse …"); Spacer() }
                        .listRowSeparator(.hidden).listRowBackground(Color.clear)
                } else if displayed == key, cursor != nil, !failedNextPage {
                    Button("Hent flere mails") { Task { await fetch(key, more: true) } }
                        .frame(maxWidth: .infinity).listRowBackground(Color.clear)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Color.mailPaper)
            .overlay { emptyState }
            .navigationTitle(folder?.displayName ?? "Postkasse")
            .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Søg i denne mappe")
            .toolbar { mailboxToolbar }
            .refreshable {
                let previous = key
                await loadFolders()
                if key == previous { await fetch(key) }
            }
            .navigationDestination(for: MailLocation.self) { location in
                if let source = folders.first(where: { $0.id == location.folder }) {
                    MessageReader(store: store, folder: source, messageID: location.id,
                                  canArchive: canMove(from: source, to: "archive"),
                                  canTrash: canMove(from: source, to: "trash"),
                                  onRead: { noteRead($0, at: location) },
                                  onAction: { try await apply($0, at: location) },
                                  compose: { compose = ComposeSeed(draft: $0) })
                } else {
                    ContentUnavailableView("Mappen findes ikke længere", systemImage: "folder")
                }
            }
            .task { if !receivedFolders { await loadFolders() } }
            .task(id: key) {
                if displayed != key { await fetch(key, debounce: !key.query.isEmpty) }
            }
        }
        .sheet(item: $compose) { seed in
            ComposeMailView(store: store, seed: seed, didSend: sent)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if let notice {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(notice).font(.subheadline)
                    Spacer()
                    Button { self.notice = nil } label: { Label("Luk", systemImage: "xmark").labelStyle(.iconOnly) }
                }
                .padding().background(.regularMaterial)
            }
        }
    }

    @ViewBuilder private var emptyState: some View {
        if listRequest == nil && listError == nil && folderError == nil && receivedFolders {
            if folders.isEmpty {
                ContentUnavailableView("Ingen mapper", systemImage: "folder")
            } else if displayed == key && messages.isEmpty && cursor == nil {
                if key.query.isEmpty {
                    ContentUnavailableView("Ingen mails i denne mappe", systemImage: folder?.symbol ?? "tray")
                } else {
                    ContentUnavailableView("Ingen mails fundet", systemImage: "magnifyingglass",
                                           description: Text("Prøv en anden afsender, modtager eller emnelinje."))
                }
            }
        }
    }

    @ToolbarContentBuilder private var mailboxToolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Menu {
                ForEach(folders) { option in
                    Button {
                        if folderID != option.id {
                            search = ""
                            folderID = option.id
                        }
                    } label: {
                        let count = option.unread > 0 ? "  (\(option.unread))" : ""
                        Label(option.displayName + count, systemImage: option.id == folderID ? "checkmark" : option.symbol)
                    }
                }
            } label: { Label("Mapper", systemImage: "folder") }
            .accessibilityIdentifier("mail-folders")
            .disabled(folders.isEmpty)
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button { compose = ComposeSeed(draft: MailDraft()) } label: {
                Label("Skriv mail", systemImage: "square.and.pencil")
            }
            .accessibilityIdentifier("mail-compose")
            Menu {
                Section(store.email) {
                    if store.canManageOrganizations, let url = URL(string: "https://mail.veyro.dk/administration") {
                        Link(destination: url) { Label("Mailadministration på web", systemImage: "safari") }
                    }
                    Button(role: .destructive) { Task { await store.logout() } } label: {
                        Label("Log ud", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                }
            } label: { Label("Konto", systemImage: "person.crop.circle") }
            .accessibilityLabel("Konto, " + store.email)
        }
    }

    private func canMove(from source: MailFolder?, to role: String) -> Bool {
        guard let source else { return false }
        return source.role != role && folders.contains { $0.role == role }
    }

    @MainActor private func loadFolders() async {
        let request = UUID()
        folderRequest = request
        defer { if folderRequest == request { folderRequest = nil } }
        do {
            let result = try await store.folders()
            guard folderRequest == request, !Task.isCancelled else { return }
            folders = result.sorted {
                $0.sortOrder == $1.sortOrder
                    ? $0.displayName.localizedStandardCompare($1.displayName) == .orderedAscending
                    : $0.sortOrder < $1.sortOrder
            }
            receivedFolders = true
            folderError = nil
            if !folders.contains(where: { $0.id == folderID }) {
                folderID = folders.first?.id ?? ""
                search = ""
            }
        } catch {
            if folderRequest == request && !Task.isCancelled { folderError = error.localizedDescription }
        }
    }

    @MainActor private func fetch(_ target: MailSearch, more: Bool = false, debounce: Bool = false) async {
        guard target == key, !target.folder.isEmpty else { return }
        if more && (displayed != target || cursor == nil || listRequest != nil) { return }
        let request = UUID(), pageCursor = more ? cursor : nil
        listRequest = request
        listError = nil
        failedNextPage = false
        if displayed != target {
            displayed = nil
            messages = []
            cursor = nil
        }
        defer { if listRequest == request { listRequest = nil } }
        do {
            if debounce { try await Task.sleep(for: .milliseconds(300)) }
            let page = try await store.messages(folder: target.folder, query: target.query, cursor: pageCursor)
            guard listRequest == request, target == key, !Task.isCancelled else { return }
            if more {
                var seen = Set(messages.map(\.id))
                messages += page.messages.filter { seen.insert($0.id).inserted }
            } else {
                messages = page.messages
            }
            displayed = target
            cursor = page.nextCursor
        } catch {
            guard listRequest == request, target == key, !Task.isCancelled else { return }
            // An expired IMAP cursor needs a fresh first page.
            failedNextPage = more && (error as? MailAPIError)?.statusCode != 409
            if more && !failedNextPage { cursor = nil }
            listError = error.localizedDescription
        }
    }

    @MainActor private func noteRead(_ item: MailMessage, at location: MailLocation) {
        guard displayed?.folder == location.folder,
              let index = messages.firstIndex(where: { $0.id == location.id }),
              messages[index].unread != item.unread else { return }
        messages[index].unread = item.unread
        Task { await loadFolders() }
    }

    private func change(_ action: MailAction, at location: MailLocation) {
        Task {
            do { try await apply(action, at: location) }
            catch { if !Task.isCancelled { notice = error.localizedDescription } }
        }
    }

    @MainActor private func apply(_ action: MailAction, at location: MailLocation) async throws {
        guard mutating.insert(location).inserted else { throw CancellationError() }
        defer { mutating.remove(location) }
        try await store.apply(action, folder: location.folder, id: location.id)
        if displayed?.folder == location.folder, let index = messages.firstIndex(where: { $0.id == location.id }) {
            switch action {
            case .archive, .trash: messages.remove(at: index)
            case .read, .unread: messages[index].unread = action == .unread
            }
        }
        // An older in-flight list response could still contain the previous state.
        let current = key
        if listRequest != nil, current.folder == location.folder { Task { await fetch(current) } }
        Task { await loadFolders() }
    }

    private func sent(_ result: SendReceipt) {
        var lines = [result.warning ?? (result.savedCopy ? "Mailen er sendt." : "Mailen er sendt, men en kopi kunne ikke gemmes i Sendt.")]
        if let refused = result.refused, !refused.isEmpty {
            lines.append("Afvist for " + refused.joined(separator: ", ") + ".")
        }
        notice = lines.joined(separator: " ")
        if folder?.role == "sent" { Task { await fetch(key) } }
    }
}
