import Foundation
import os
import UserNotifications

/// Ids and steps only, never credentials or message content.
let pushLog = Logger(subsystem: "org.bulwarkmail.mobile.NotificationService", category: "push")

/// Turns the relay's content-blind push ("New message" plus ids) into a real
/// notification: sender, subject and preview, fetched over JMAP on this
/// device with the account's own credentials. Nothing about the message ever
/// passes through the relay or Apple.
///
/// What the app shares through the keychain group (src/lib/ios-push-shared.ts):
///   bulwark_push_account__<JMAP account id>  {credentialsKey, apiUrl}
///   bulwark_push_settings                    {badge, activeAccountId, strings{...}}
///   <credentialsKey>                         the account's stored credentials
/// If anything is missing or the server can't be reached, the relay's
/// placeholder text is shown, so the user still learns there is new mail.
final class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var placeholder: UNMutableNotificationContent?
  private var work: Task<Void, Never>?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
      contentHandler(request.content)
      return
    }
    placeholder = content
    let push = request.content.userInfo["body"] as? [String: Any]
    work = Task { [weak self] in
      let enriched = await NotificationService.enrich(content, push: push)
      self?.finish(enriched)
    }
  }

  override func serviceExtensionTimeWillExpire() {
    work?.cancel()
    finish(placeholder)
  }

  private func finish(_ content: UNNotificationContent?) {
    guard let handler = contentHandler, let content else { return }
    contentHandler = nil
    handler(content)
  }

  static func sanitize(_ id: String) -> String {
    String(id.map { ch in (ch.isASCII && (ch.isLetter || ch.isNumber)) || ch == "." || ch == "-" || ch == "_" ? ch : "_" })
  }

  static func enrich(_ content: UNMutableNotificationContent, push: [String: Any]?) async -> UNMutableNotificationContent {
    guard let push, let accountId = push["accountId"] as? String, !accountId.isEmpty else {
      pushLog.error("push without an account id")
      return content
    }
    pushLog.info("push for account \(accountId, privacy: .public), group \(SharedKeychain.group ?? "none", privacy: .public)")
    guard let account = SharedKeychain.readJSON("bulwark_push_account__\(sanitize(accountId))"),
          let credentialsKey = account["credentialsKey"] as? String,
          let apiString = account["apiUrl"] as? String,
          let apiUrl = URL(string: apiString) else {
      pushLog.error("no shared account entry for \(accountId, privacy: .public)")
      return content
    }
    let emailIds = push["emailIds"] as? [String] ?? []
    let settings = SharedKeychain.readJSON("bulwark_push_settings") ?? [:]
    let strings = settings["strings"] as? [String: String] ?? [:]

    content.threadIdentifier = accountId
    // The app reads userInfo.body when the notification is tapped.
    var body = push

    do {
      let authorization = try await Jmap.authorization(credentialsKey: credentialsKey)
      let result = try await Jmap.fetch(apiUrl: apiUrl, accountId: accountId, emailIds: emailIds, authorization: authorization)
      pushLog.info("fetched \(result.emails.count, privacy: .public) of \(emailIds.count, privacy: .public) messages")

      if let first = result.emails.first {
        content.title = first.sender
        content.subtitle = first.subject.isEmpty ? (strings["noSubject"] ?? "(no subject)") : first.subject
        content.body = first.preview
        if result.emails.count > 1 {
          let more = (strings["more"] ?? "and {count} more").replacingOccurrences(of: "{count}", with: String(result.emails.count - 1))
          content.body = first.preview.isEmpty ? more : "\(first.preview)\n\(more)"
        }
        body["emailId"] = first.id
        body["threadId"] = first.threadId
      }

      // Badge: like the app, the active account's inbox unread count. A push
      // for another account leaves the badge as it is.
      if settings["badge"] as? Bool == true,
         settings["activeAccountId"] as? String == accountId,
         let unread = result.inboxUnread {
        content.badge = NSNumber(value: unread)
      }
    } catch {
      // Keep the placeholder.
      pushLog.error("fetch failed: \(String(describing: error), privacy: .public)")
    }
    var userInfo = content.userInfo
    userInfo["body"] = body
    content.userInfo = userInfo
    return content
  }
}
