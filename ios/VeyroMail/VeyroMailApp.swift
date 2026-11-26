import SwiftUI

@main
struct VeyroMailApp: App {
    @StateObject private var store: MailStore
    @Environment(\.scenePhase) private var scenePhase

    init() {
        #if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("-VeyroMailUITestFixture") {
            _store = StateObject(wrappedValue: MailStore(api: SimulatorMailboxFixture.api()))
            return
        }
        #endif
        _store = StateObject(wrappedValue: MailStore())
    }

    var body: some Scene {
        WindowGroup {
            ZStack {
                switch store.phase {
                case .starting, .signingOut:
                    ProgressView(store.phase == .starting ? "Åbner Veyro Mail …" : "Logger ud …")
                case .signedOut:
                    SignInView(store: store)
                case .signedIn:
                    MailboxView(store: store)
                case .restoreFailed:
                    VStack(spacing: 18) {
                        Image(systemName: "envelope.badge")
                            .font(.largeTitle)
                            .accessibilityHidden(true)
                        Text("Postkassen kunne ikke åbnes").font(.headline)
                        Text(store.authMessage ?? "Prøv igen om lidt.")
                            .foregroundStyle(.secondary)
                        Button("Prøv igen") { Task { await store.restore() } }
                            .buttonStyle(.borderedProminent)
                        Button("Skift konto") { Task { await store.logout() } }
                    }
                    .multilineTextAlignment(.center)
                    .padding()
                }
                if scenePhase != .active && store.phase == .signedIn {
                    Color(uiColor: .systemBackground).ignoresSafeArea()
                        .overlay { VeyroMark().frame(width: 54, height: 54) }
                        .accessibilityHidden(true)
                }
            }
            .tint(Color(uiColor: .init { traits in
                traits.userInterfaceStyle == .dark
                    ? UIColor(red: 1, green: 0.53, blue: 0.33, alpha: 1)
                    : UIColor(red: 0.66, green: 0.22, blue: 0.07, alpha: 1)
            }))
            .task { await store.restore() }
        }
    }
}
