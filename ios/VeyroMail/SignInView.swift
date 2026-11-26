import SwiftUI

struct VeyroMark: View {
    var body: some View {
        Canvas { context, size in
            context.scaleBy(x: size.width / 64, y: size.height / 64)
            context.fill(Path(roundedRect: CGRect(x: 0, y: 0, width: 64, height: 64), cornerRadius: 14),
                         with: .color(Color(red: 0.06, green: 0.06, blue: 0.05)))
            var letter = Path()
            letter.move(to: CGPoint(x: 17, y: 18))
            for point in [CGPoint(x: 25, y: 18), CGPoint(x: 32, y: 38), CGPoint(x: 39, y: 18),
                          CGPoint(x: 47, y: 18), CGPoint(x: 36, y: 47), CGPoint(x: 28, y: 47)] {
                letter.addLine(to: point)
            }
            letter.closeSubpath()
            context.fill(letter, with: .color(Color(red: 0.98, green: 0.98, blue: 0.97)))
            context.fill(Path(ellipseIn: CGRect(x: 45, y: 41, width: 8, height: 8)),
                         with: .color(Color(red: 1, green: 0.35, blue: 0.12)))
        }
        .accessibilityHidden(true)
    }
}

struct SignInView: View {
    @ObservedObject var store: MailStore
    @State private var email = ""
    @State private var password = ""
    @State private var showRecovery = false
    @FocusState private var focus: Field?
    private enum Field { case email, password }
    @ScaledMetric private var topSpacing = 42.0
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack(spacing: 10) {
                    VeyroMark().frame(width: 38, height: 38)
                    Text(verbatim: "Veyro Mail").font(.title2.weight(.semibold))
                }
                Text("Log ind")
                    .font(.largeTitle.bold())
                    .accessibilityAddTraits(.isHeader)
                    .padding(.top, 20)
                VStack(alignment: .leading, spacing: 10) {
                    Text("Mailadresse").font(.subheadline.weight(.semibold))
                    TextField("navn@virksomhed.dk", text: $email)
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .email)
                        .accessibilityLabel("Mailadresse")
                        .submitLabel(.next)
                        .onSubmit { focus = .password }
                        .modifier(LoginField())
                }
                VStack(alignment: .leading, spacing: 10) {
                    Text("Adgangskode").font(.subheadline.weight(.semibold))
                    SecureField("Din adgangskode", text: $password)
                        .textContentType(.password)
                        .focused($focus, equals: .password)
                        .accessibilityLabel("Adgangskode")
                        .submitLabel(.go)
                        .onSubmit(submit)
                        .modifier(LoginField())
                }
                if let message = store.authMessage {
                    Text(message).font(.callout).foregroundStyle(.red)
                }
                Button(action: submit) {
                    HStack(spacing: 8) {
                        if store.isSigningIn { ProgressView().tint(Color(uiColor: .systemBackground)) }
                        Text(store.isSigningIn ? "Logger ind …" : "Log ind").fontWeight(.semibold)
                    }
                    .frame(maxWidth: .infinity, minHeight: 52)
                }
                .foregroundStyle(Color(uiColor: .systemBackground))
                .background(Color.primary, in: RoundedRectangle(cornerRadius: 13))
                .disabled(!canSubmit)
                Button("Glemt adgangskode?") { showRecovery = true }
                    .frame(minHeight: 44)
            }
            .frame(maxWidth: 430, alignment: .leading)
            .padding(.horizontal, 24)
            .padding(.top, topSpacing)
            .padding(.bottom, 24)
            .frame(maxWidth: .infinity)
        }
        .background(colorScheme == .dark ? Color(uiColor: .systemBackground) : Color(red: 0.979, green: 0.976, blue: 0.963))
        .scrollDismissesKeyboard(.interactively)
        .sheet(isPresented: $showRecovery) { RecoveryView(store: store, address: email) }
    }

    private var canSubmit: Bool {
        !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !password.isEmpty && !store.isSigningIn
    }

    private func submit() {
        guard canSubmit else { return }
        focus = nil
        Task { await store.login(email: email, password: password) }
    }
}

private struct LoginField: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 14)
            .padding(.vertical, 13)
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
            .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(Color.secondary.opacity(0.35)) }
    }
}

private struct RecoveryView: View {
    @ObservedObject var store: MailStore
    @State var address: String
    @State private var sending = false
    @State private var sent = false
    @State private var failure: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                if sent {
                    Text("Hvis kontoen har en gendannelsesmail, får du et link dér. Du kan også få hjælp hos virksomhedens mailadministrator.")
                } else {
                    TextField("Mailadresse", text: $address)
                        .keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                    if let failure { Text(failure).foregroundStyle(.red) }
                    Button(sending ? "Sender …" : "Bed om nulstilling") {
                        sending = true
                        failure = nil
                        Task {
                            defer { sending = false }
                            do { try await store.requestPasswordReset(email: address); sent = true }
                            catch { failure = error.localizedDescription }
                        }
                    }
                    .disabled(sending || address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .navigationTitle("Glemt adgangskode")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Luk") { dismiss() } }
            }
        }
    }
}
