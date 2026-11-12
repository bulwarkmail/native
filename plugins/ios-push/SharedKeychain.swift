import Foundation
import os
import Security

/// Ids and steps only, never credentials or message content. Shared by the
/// notification extension and the app's push renewal (PushRenewal.swift).
let pushLog = os.Logger(subsystem: Bundle.main.bundleIdentifier ?? "org.bulwarkmail.mobile", category: "push")

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
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess else {
      pushLog.error("keychain read of \(key, privacy: .public) failed: \(status, privacy: .public)")
      return nil
    }
    return item as? Data
  }

  /// SecureStore keys: letters, digits, ".", "-", "_" only. The app builds
  /// the same key part (src/lib/ios-push-shared.ts keyPart).
  static func keyPart(_ id: String) -> String {
    String(id.map { ch in (ch.isASCII && (ch.isLetter || ch.isNumber)) || ch == "." || ch == "-" || ch == "_" ? ch : "_" })
  }

  /// The keys of the shared items whose key starts with `prefix`.
  static func keys(withPrefix prefix: String) -> [String] {
    guard let group else { return [] }
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccessGroup as String: group,
      kSecMatchLimit as String: kSecMatchLimitAll,
      kSecReturnAttributes as String: true,
    ]
    var items: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &items)
    guard status == errSecSuccess, let list = items as? [[String: Any]] else {
      if status != errSecItemNotFound {
        pushLog.error("keychain listing failed: \(status, privacy: .public)")
      }
      return []
    }
    return list.compactMap { item in
      let account = item[kSecAttrAccount as String]
      let key = (account as? Data).flatMap { String(data: $0, encoding: .utf8) } ?? (account as? String)
      guard let key, key.hasPrefix(prefix) else { return nil }
      return key
    }
  }

  static func readJSON(_ key: String) -> [String: Any]? {
    guard let data = read(key) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }

  /// Prefix of the stored sign-ins (src/api/jmap-client.ts credentialsKey,
  /// and the single-account key before it).
  static let credentialsPrefix = "jmap_credentials"

  /// Puts every item of the shared group, and every stored sign-in in any of
  /// the app's groups, in the "this device only" variant of its class
  /// (src/lib/ios-push-shared.ts sharedStoreOptions writes new ones that
  /// way): such items stay out of encrypted backups and device transfers. An
  /// item keeps the class it was added with, so the ones earlier versions
  /// added are changed here, in place: only the attribute is updated, the
  /// item is never missing and its value never rewritten, so a read or a
  /// token refresh at the same moment sees it as before. Run by the app at
  /// launch; before the first unlock the keychain refuses and the next launch
  /// tries again. Items already on this device only (the crypto keys) are
  /// left as they are.
  static func keepOnThisDevice() {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecMatchLimit as String: kSecMatchLimitAll,
      kSecReturnAttributes as String: true,
    ]
    var items: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &items)
    guard status == errSecSuccess, let list = items as? [[String: Any]] else {
      if status != errSecItemNotFound {
        pushLog.error("keychain listing for the class change failed: \(status, privacy: .public)")
      }
      return
    }
    for item in list {
      guard let account = item[kSecAttrAccount as String],
            let itemGroup = item[kSecAttrAccessGroup as String] as? String,
            let current = item[kSecAttrAccessible as String] as? String,
            let next = deviceOnlyClass(of: current) else { continue }
      let key = (account as? Data).flatMap { String(data: $0, encoding: .utf8) } ?? (account as? String) ?? ""
      guard itemGroup == group || key.hasPrefix(credentialsPrefix) else { continue }
      let match: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecAttrAccessGroup as String: itemGroup,
      ]
      let update = SecItemUpdate(match as CFDictionary, [kSecAttrAccessible as String: next] as CFDictionary)
      if update != errSecSuccess {
        pushLog.error("keychain class of \(key, privacy: .public) not changed: \(update, privacy: .public)")
      }
    }
  }

  /// The "this device only" variant of a class, nil when it already is one.
  /// "dk" is the deprecated Always class, which gets the shared items' class.
  static func deviceOnlyClass(of current: String) -> CFString? {
    // Compared as strings: in a switch, `case kSec... as String` reads as a cast
    // pattern on the String value and doesn't compile.
    let whenUnlocked = kSecAttrAccessibleWhenUnlocked as String
    let afterFirstUnlock = kSecAttrAccessibleAfterFirstUnlock as String
    switch current {
    case whenUnlocked: return kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    case afterFirstUnlock: return kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    case "dk": return kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    default: return nil
    }
  }

  /// Replaces the value of an existing item (refreshed OAuth tokens). Never
  /// creates one: the app owns which items exist. Only the data changes, so
  /// the item keeps its class (this device only, see keepOnThisDevice).
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
