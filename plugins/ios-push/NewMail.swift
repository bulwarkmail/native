import Foundation

struct NotifiedMail: Equatable {
  var ids: [String]
  var newest: Date?
}

enum NewMail {
  static let mailTypes: Set<String> = ["EmailDelivery", "Email", "Mailbox"]
  static let queryLimit = 5
  static let ringLimit = 200
  static let firstWindow: TimeInterval = 60 * 60
  static let arrivalSlack: TimeInterval = 10 * 60
  static let keyPrefix = "bulwark.notifiedMail."

  static func mayCarryMail(_ push: [String: Any]) -> Bool {
    guard push["kind"] as? String == "jmap-state-change",
          let changed = push["changed"] as? [String: Any] else { return true }
    var namesTypes = false
    for entry in changed.values {
      guard let map = entry as? [String: Any] else { return true }
      let types = Set(map.keys)
      if !types.isEmpty { namesTypes = true }
      if types.contains("Email") && !types.contains("EmailDelivery") { continue }
      if !types.isDisjoint(with: mailTypes) { return true }
    }
    return !namesTypes
  }

  static func fresh(_ emails: [PushedEmail], notified: NotifiedMail?, now: Date) -> [PushedEmail] {
    let shown = Set(notified?.ids ?? [])
    let since = notified?.newest.map { $0.addingTimeInterval(-arrivalSlack) } ?? now.addingTimeInterval(-firstWindow)
    return emails.filter { email in
      guard !shown.contains(email.id) else { return false }
      guard let at = email.receivedAt else { return true }
      return at >= since
    }
  }

  static func noting(_ emails: [PushedEmail], in notified: NotifiedMail?) -> NotifiedMail {
    let added = emails.map(\.id)
    let kept = (notified?.ids ?? []).filter { !added.contains($0) }
    let dates = emails.compactMap(\.receivedAt) + [notified?.newest].compactMap { $0 }
    return NotifiedMail(ids: Array((added + kept).prefix(ringLimit)), newest: dates.max())
  }

  static let lock = NSLock()

  static func claim(_ emails: [PushedEmail], key: String, lookUp: Bool, now: Date, defaults: UserDefaults = .standard) -> [PushedEmail] {
    lock.lock()
    defer { lock.unlock() }
    let notified = read(key, defaults: defaults)
    let shown = lookUp ? fresh(emails, notified: notified, now: now) : emails
    if !shown.isEmpty { write(noting(shown, in: notified), for: key, defaults: defaults) }
    return shown
  }

  static func read(_ accountId: String, defaults: UserDefaults = .standard) -> NotifiedMail? {
    guard let stored = defaults.dictionary(forKey: keyPrefix + accountId),
          let ids = stored["ids"] as? [String] else { return nil }
    let newest = (stored["newest"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue) }
    return NotifiedMail(ids: ids, newest: newest)
  }

  static func write(_ notified: NotifiedMail, for accountId: String, defaults: UserDefaults = .standard) {
    var stored: [String: Any] = ["ids": notified.ids]
    if let newest = notified.newest { stored["newest"] = newest.timeIntervalSince1970 }
    defaults.set(stored, forKey: keyPrefix + accountId)
  }
}
