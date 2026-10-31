import Foundation

/// The little JMAP the extension needs: who sent the new messages and what
/// they are about, plus the inbox's unread count for the badge.
struct PushedEmail {
  let id: String
  let threadId: String
  let sender: String
  let subject: String
  let preview: String
}

struct JmapFetchResult {
  let emails: [PushedEmail]
  let inboxUnread: Int?
}

enum JmapError: Error {
  case noCredentials
  /// The access token needs a refresh the caller didn't allow.
  case needsRefresh
  case http(Int)
  case badResponse
}

/// Credentials as the app stores them (src/api/jmap-client.ts StoredCredentials).
struct StoredCredentials {
  var json: [String: Any]

  var username: String { json["username"] as? String ?? "" }
  var password: String { json["password"] as? String ?? "" }
  var accessToken: String? { json["accessToken"] as? String }
  var refreshToken: String? { json["refreshToken"] as? String }
  var tokenEndpoint: String? { json["tokenEndpoint"] as? String }
  var clientId: String? { json["clientId"] as? String }
  /// Milliseconds since 1970, like Date.now() in the app.
  var expiresAt: Double? { (json["expiresAt"] as? NSNumber)?.doubleValue }
}

enum Jmap {
  static let session: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 12
    config.timeoutIntervalForResource = 20
    return URLSession(configuration: config)
  }()

  /// The Authorization header for these credentials, refreshing an OAuth
  /// access token that is about to expire. A refreshed bundle is written back
  /// to the shared keychain item so the app picks it up (and doesn't refresh
  /// again with a refresh token the server has already replaced).
  ///
  /// `allowRefresh: false` throws instead of refreshing: the app's foreground
  /// renewal leaves that to the app's own code, which runs then too and would
  /// race it for the same refresh token.
  static func authorization(credentialsKey: String, allowRefresh: Bool = true) async throws -> String {
    guard let json = SharedKeychain.readJSON(credentialsKey) else { throw JmapError.noCredentials }
    var creds = StoredCredentials(json: json)
    if let token = creds.accessToken {
      let nowMs = Date().timeIntervalSince1970 * 1000
      if !allowRefresh, let expiresAt = creds.expiresAt, expiresAt - nowMs < 60_000 {
        throw JmapError.needsRefresh
      }
      if let expiresAt = creds.expiresAt, expiresAt - nowMs < 60_000,
         let refresh = creds.refreshToken, let endpoint = creds.tokenEndpoint, let clientId = creds.clientId,
         let url = URL(string: endpoint) {
        if let fresh = try? await refreshToken(url: url, refreshToken: refresh, clientId: clientId) {
          creds.json["accessToken"] = fresh.accessToken
          if let newRefresh = fresh.refreshToken { creds.json["refreshToken"] = newRefresh }
          if let expiresIn = fresh.expiresIn { creds.json["expiresAt"] = nowMs + expiresIn * 1000 }
          SharedKeychain.update(credentialsKey, json: creds.json)
          return "Bearer \(fresh.accessToken)"
        }
      }
      return "Bearer \(token)"
    }
    let basic = Data("\(creds.username):\(creds.password)".utf8).base64EncodedString()
    return "Basic \(basic)"
  }

  struct FreshTokens {
    let accessToken: String
    let refreshToken: String?
    let expiresIn: Double?
  }

  static func refreshToken(url: URL, refreshToken: String, clientId: String) async throws -> FreshTokens {
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    var form = URLComponents()
    form.queryItems = [
      URLQueryItem(name: "grant_type", value: "refresh_token"),
      URLQueryItem(name: "refresh_token", value: refreshToken),
      URLQueryItem(name: "client_id", value: clientId),
    ]
    request.httpBody = form.percentEncodedQuery?.data(using: .utf8)
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw JmapError.badResponse }
    guard http.statusCode == 200 else { throw JmapError.http(http.statusCode) }
    guard let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let access = body["access_token"] as? String else { throw JmapError.badResponse }
    return FreshTokens(
      accessToken: access,
      refreshToken: body["refresh_token"] as? String,
      expiresIn: (body["expires_in"] as? NSNumber)?.doubleValue
    )
  }

  /// One JMAP request; the method responses as the server sent them.
  static func call(apiUrl: URL, authorization: String, using: [String], methodCalls: [[Any]]) async throws -> [[Any]] {
    var request = URLRequest(url: apiUrl)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue(authorization, forHTTPHeaderField: "Authorization")
    let body: [String: Any] = ["using": using, "methodCalls": methodCalls]
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw JmapError.badResponse }
    guard http.statusCode == 200 else { throw JmapError.http(http.statusCode) }
    guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let responses = root["methodResponses"] as? [[Any]] else { throw JmapError.badResponse }
    return responses
  }

  struct ListedPushSubscription {
    let id: String
    let deviceClientId: String?
    let expires: String?
  }

  static let pushSubscriptionProperties = ["id", "deviceClientId", "expires"]

  /// Subscription `id` as the PushSubscription/get answer `callId` lists it.
  static func listedPushSubscription(_ responses: [[Any]], callId: String, id: String) -> ListedPushSubscription? {
    for response in responses where response.count >= 3 {
      guard response[0] as? String == "PushSubscription/get", response[2] as? String == callId,
            let args = response[1] as? [String: Any],
            let list = args["list"] as? [[String: Any]] else { continue }
      for item in list where item["id"] as? String == id {
        return ListedPushSubscription(
          id: id,
          deviceClientId: item["deviceClientId"] as? String,
          expires: item["expires"] as? String
        )
      }
    }
    return nil
  }

  static func pushSubscription(apiUrl: URL, id: String, authorization: String) async throws -> ListedPushSubscription? {
    let methodCalls: [[Any]] = [
      ["PushSubscription/get", ["ids": [id], "properties": pushSubscriptionProperties], "0"],
    ]
    let responses = try await call(apiUrl: apiUrl, authorization: authorization, using: ["urn:ietf:params:jmap:core"], methodCalls: methodCalls)
    return listedPushSubscription(responses, callId: "0", id: id)
  }

  /// Asks for a later expiry and reads back the one the server settled on:
  /// servers clamp it, and the update's answer doesn't say.
  static func extendPushSubscription(apiUrl: URL, id: String, expires: String, authorization: String) async throws -> ListedPushSubscription? {
    let methodCalls: [[Any]] = [
      ["PushSubscription/set", ["update": [id: ["expires": expires]]], "0"],
      ["PushSubscription/get", ["ids": [id], "properties": pushSubscriptionProperties], "1"],
    ]
    let responses = try await call(apiUrl: apiUrl, authorization: authorization, using: ["urn:ietf:params:jmap:core"], methodCalls: methodCalls)
    return listedPushSubscription(responses, callId: "1", id: id)
  }

  static func fetch(apiUrl: URL, accountId: String, emailIds: [String], authorization: String) async throws -> JmapFetchResult {
    var request = URLRequest(url: apiUrl)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue(authorization, forHTTPHeaderField: "Authorization")
    let body: [String: Any] = [
      "using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      "methodCalls": [
        ["Email/get", [
          "accountId": accountId,
          "ids": Array(emailIds.prefix(5)),
          "properties": ["threadId", "from", "subject", "preview"],
        ], "0"],
        ["Mailbox/query", ["accountId": accountId, "filter": ["role": "inbox"]], "1"],
        ["Mailbox/get", [
          "accountId": accountId,
          "#ids": ["resultOf": "1", "name": "Mailbox/query", "path": "/ids"],
          "properties": ["unreadEmails"],
        ], "2"],
      ],
    ]
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw JmapError.badResponse }
    guard http.statusCode == 200 else { throw JmapError.http(http.statusCode) }
    guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let responses = root["methodResponses"] as? [[Any]] else { throw JmapError.badResponse }

    var emails: [PushedEmail] = []
    var inboxUnread: Int?
    for response in responses where response.count >= 2 {
      guard let name = response[0] as? String, let args = response[1] as? [String: Any] else { continue }
      if name == "Email/get", let list = args["list"] as? [[String: Any]] {
        // Keep the order the push gave (newest first from the server's filter).
        // Stalwart can list an id twice; keep the first.
        let byId = Dictionary(list.compactMap { item -> (String, [String: Any])? in
          guard let id = item["id"] as? String else { return nil }
          return (id, item)
        }, uniquingKeysWith: { first, _ in first })
        for id in emailIds {
          guard let item = byId[id] else { continue }
          let from = (item["from"] as? [[String: Any]])?.first
          let name = (from?["name"] as? String).flatMap { $0.isEmpty ? nil : $0 }
          let sender = name ?? (from?["email"] as? String) ?? ""
          emails.append(PushedEmail(
            id: id,
            threadId: item["threadId"] as? String ?? "",
            sender: sender,
            subject: item["subject"] as? String ?? "",
            preview: item["preview"] as? String ?? ""
          ))
        }
      } else if name == "Mailbox/get", let list = args["list"] as? [[String: Any]] {
        inboxUnread = (list.first?["unreadEmails"] as? NSNumber)?.intValue
      }
    }
    return JmapFetchResult(emails: emails, inboxUnread: inboxUnread)
  }
}
