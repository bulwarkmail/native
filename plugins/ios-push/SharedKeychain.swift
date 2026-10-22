import Foundation
import Security

/// Items the app shares with this extension through a keychain access group
/// (BulwarkKeychainGroup in Info.plist). The app writes them with
/// expo-secure-store: generic passwords whose account and generic attributes
/// are the UTF-8 key and whose service is "app:no-auth".
enum SharedKeychain {
  static let service = "app:no-auth"

  static var group: String? {
    Bundle.main.object(forInfoDictionaryKey: "BulwarkKeychainGroup") as? String
  }

  static func read(_ key: String) -> Data? {
    guard let group else { return nil }
    let account = Data(key.utf8)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrAccount as String: account,
      kSecAttrAccessGroup as String: group,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: true,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
    return item as? Data
  }

  static func readJSON(_ key: String) -> [String: Any]? {
    guard let data = read(key) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }

  /// Replaces the value of an existing item (refreshed OAuth tokens). Never
  /// creates one: the app owns which items exist.
  @discardableResult
  static func update(_ key: String, json: [String: Any]) -> Bool {
    guard let group, let data = try? JSONSerialization.data(withJSONObject: json) else { return false }
    let account = Data(key.utf8)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrAccessGroup as String: group,
    ]
    let attributes: [String: Any] = [kSecValueData as String: data]
    return SecItemUpdate(query as CFDictionary, attributes as CFDictionary) == errSecSuccess
  }
}
