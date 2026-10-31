import Foundation

/// Keeps push alive on iOS. Stalwart (0.16 and 1.0) drops a PushSubscription
/// seven days after its last refresh, and the app's JS refreshes it only when
/// the app starts. On Android a push handled in the background extends it
/// (src/lib/push-background-task.ts extendPushSubscription); on iOS pushes
/// reach the notification extension, not the app's JS, so someone who reads
/// mail from the notifications without opening the app lost push after a
/// week. The same steps run here instead: in the notification extension for
/// the pushed account, and in the app (PushRenewalTask.swift) on foreground
/// and from a background refresh task for every account.
///
/// The app shares each account's subscription in the account's entry
/// (src/lib/ios-push-shared.ts IosPushAccount): subscriptionId,
/// deviceClientId and subscriptionExpires. Only a subscription that is
/// recorded there and has less than six days left (or an unknown expiry) is
/// looked at; then the server's copy is read first, since the record can be
/// older than it, and only this device's own subscription is extended.
enum PushRenewal {
  static let accountPrefix = "bulwark_push_account__"
  /// BACKGROUND_EXTEND_BELOW_MS in src/lib/push-notifications.ts.
  static let extendBelowSeconds: TimeInterval = 6 * 24 * 60 * 60
  /// SUBSCRIPTION_EXPIRES_DAYS in src/lib/push-notifications.ts; servers clamp it.
  static let wantedSeconds: TimeInterval = 90 * 24 * 60 * 60

  static func parseDate(_ value: String?) -> Date? {
    guard let value, !value.isEmpty else { return nil }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
  }

  /// A JMAP UTCDate, without fractional seconds.
  static func formatDate(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.string(from: date)
  }

  /// pushSubscriptionNeedsExtension in src/lib/push-notifications.ts.
  static func needsExtension(_ expires: String?, now: Date = Date()) -> Bool {
    guard let at = parseDate(expires) else { return true }
    return at.timeIntervalSince(now) < extendBelowSeconds
  }

  /// A server that reused the id may hand back another device's subscription.
  static func isOwn(_ listed: Jmap.ListedPushSubscription, deviceClientId: String?) -> Bool {
    guard let theirs = listed.deviceClientId, let ours = deviceClientId else { return true }
    return theirs == ours
  }

  /// The pushed account's subscription, if it is due.
  static func renewIfDue(jmapAccountId: String) async {
    await renew(key: accountPrefix + SharedKeychain.keyPart(jmapAccountId), allowRefresh: true)
  }

  /// Every shared account's subscription that is due, one after the other.
  static func renewAll(allowRefresh: Bool) async {
    for key in SharedKeychain.keys(withPrefix: accountPrefix) {
      if Task.isCancelled { return }
      await renew(key: key, allowRefresh: allowRefresh)
    }
  }

  /// True when the subscription was extended. Best effort: anything that
  /// fails is tried again on the next push, foreground or refresh task.
  @discardableResult
  static func renew(key: String, allowRefresh: Bool) async -> Bool {
    guard let account = SharedKeychain.readJSON(key),
          let subscriptionId = account["subscriptionId"] as? String, !subscriptionId.isEmpty,
          let credentialsKey = account["credentialsKey"] as? String,
          let apiString = account["apiUrl"] as? String,
          let apiUrl = URL(string: apiString) else { return false }
    guard needsExtension(account["subscriptionExpires"] as? String) else { return false }
    let deviceClientId = account["deviceClientId"] as? String
    do {
      let authorization = try await Jmap.authorization(credentialsKey: credentialsKey, allowRefresh: allowRefresh)
      guard let current = try await Jmap.pushSubscription(apiUrl: apiUrl, id: subscriptionId, authorization: authorization),
            isOwn(current, deviceClientId: deviceClientId) else {
        // Lapsed or revoked: the app's resync tells the two apart.
        pushLog.info("subscription \(subscriptionId, privacy: .public) is not on the server")
        return false
      }
      // The recorded expiry was stale: the server's copy has time left.
      if let expires = current.expires, !needsExtension(expires) {
        record(key: key, account: account, expires: expires)
        return false
      }
      let wanted = formatDate(Date().addingTimeInterval(wantedSeconds))
      let extended = try await Jmap.extendPushSubscription(
        apiUrl: apiUrl, id: subscriptionId, expires: wanted, authorization: authorization)
      if let expires = extended?.expires { record(key: key, account: account, expires: expires) }
      pushLog.info("extended subscription \(subscriptionId, privacy: .public)")
      return true
    } catch {
      pushLog.error("renewal failed: \(String(describing: error), privacy: .public)")
      return false
    }
  }

  private static func record(key: String, account: [String: Any], expires: String) {
    var json = account
    json["subscriptionExpires"] = expires
    SharedKeychain.update(key, json: json)
  }
}
