import Foundation
import Security

struct SessionVault: MailSessionVault {
    private var entry: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "dk.veyro.mail.session",
            kSecAttrAccount as String: "mail.veyro.dk"
        ]
    }

    func load() throws -> String? {
        var query = entry
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else { throw VaultError() }
        return value
    }

    func save(_ value: String) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        let status = SecItemUpdate(entry as CFDictionary, attributes as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw VaultError() }
        let item = entry.merging(attributes) { _, new in new }
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw VaultError() }
    }

    func clear() throws {
        let status = SecItemDelete(entry as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw VaultError() }
    }

    private struct VaultError: LocalizedError {
        var errorDescription: String? { "iPhone kunne ikke åbne nøgleringen. Lås telefonen op, og prøv igen." }
    }
}
