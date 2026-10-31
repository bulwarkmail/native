import Foundation
import React
import Security
import UIKit
import UniformTypeIdentifiers

/// TLS client certificates on iOS (#3): the counterpart of Android's
/// BulwarkClientCertModule.kt, with the same methods and results, so
/// src/lib/client-cert.ts drives both.
///
///   pickAlias(host)  the user picks a .p12/.pfx file in Files and types its
///                    password; the identity goes into the app's keychain.
///                    Resolves with the certificate's name, or null when the
///                    user cancels.
///   getAlias()       that name, or null.
///   clearAlias()     forgets the certificate and removes it from the keychain.
///   fetchSecure(r)   one request over URLSession that answers the server's
///                    client-certificate challenge with the identity.
///
/// iOS has no store of client certificates that apps can pick from, like
/// Android's KeyChain: identities installed with a configuration profile are
/// only reachable by Apple's own apps. So the user brings the file.
///
/// React Native's own fetch can't answer the challenge: its URLSession
/// delegate (RCTHTTPRequestHandler) takes the default handling, and the
/// configuration hook RN offers can't add a delegate. Hence fetchSecure, as
/// on Android, which src/lib/client-cert.ts routes every request through once
/// a certificate is set.
@objc(BulwarkClientCert)
final class BulwarkClientCert: NSObject, UIDocumentPickerDelegate {
  @objc static func requiresMainQueueSetup() -> Bool { false }

  private var pending: (resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock, host: String?)?

  // MARK: alias management

  @objc(getAlias:rejecter:)
  func getAlias(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    resolve(ClientIdentityStore.alias)
  }

  @objc(clearAlias:rejecter:)
  func clearAlias(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    ClientIdentityStore.clear()
    SecureSession.reset()
    resolve(nil)
  }

  @objc(pickAlias:resolver:rejecter:)
  func pickAlias(
    _ host: String?,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      guard let presenter = RCTPresentedViewController() else {
        reject("no_activity", "No screen to show the file picker on", nil)
        return
      }
      if let previous = self.pending {
        previous.resolve(nil)
      }
      self.pending = (resolve, reject, host)
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.pkcs12], asCopy: true)
      picker.delegate = self
      picker.allowsMultipleSelection = false
      presenter.present(picker, animated: true)
    }
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    settle { resolve, _ in resolve(nil) }
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard let url = urls.first, let data = try? Data(contentsOf: url) else {
      settle { _, reject in reject("pick_failed", "The certificate file could not be read", nil) }
      return
    }
    try? FileManager.default.removeItem(at: url)
    // The picker may still be on its way out; an alert presented over it
    // would not show.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
      self.askPassword(for: data, wrongPassword: false)
    }
  }

  /// Asks for the file's password; again after a wrong one.
  private func askPassword(for data: Data, wrongPassword: Bool) {
    guard let presenter = RCTPresentedViewController() else {
      settle { _, reject in reject("no_activity", "No screen to ask for the password on", nil) }
      return
    }
    let host = pending?.host
    let message = wrongPassword
      ? "That password is wrong. Try again."
      : (host.map { "The certificate for \($0) is protected by a password." } ?? "The certificate is protected by a password.")
    let alert = UIAlertController(title: "Certificate password", message: message, preferredStyle: .alert)
    alert.addTextField { field in
      field.isSecureTextEntry = true
      field.textContentType = .password
    }
    alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in
      self.settle { resolve, _ in resolve(nil) }
    })
    alert.addAction(UIAlertAction(title: "Import", style: .default) { [weak alert] _ in
      let password = alert?.textFields?.first?.text ?? ""
      switch ClientIdentityStore.importPKCS12(data, password: password) {
      case .success(let alias):
        SecureSession.reset()
        self.settle { resolve, _ in resolve(alias) }
      case .wrongPassword:
        self.askPassword(for: data, wrongPassword: true)
      case .failure(let message):
        self.settle { _, reject in reject("pick_failed", message, nil) }
      }
    })
    presenter.present(alert, animated: true)
  }

  private func settle(_ body: (RCTPromiseResolveBlock, RCTPromiseRejectBlock) -> Void) {
    guard let current = pending else { return }
    pending = nil
    body(current.resolve, current.reject)
  }

  // MARK: secure fetch

  /// request: {url, method, headers: {k: v}, bodyBase64: string|null, timeoutMs: number}
  /// Resolves with {status, statusText, headers, bodyBase64}. Redirects come
  /// back as they are: src/lib/client-cert.ts decides which to follow.
  @objc(fetchSecure:resolver:rejecter:)
  func fetchSecure(
    _ request: NSDictionary,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let urlString = request["url"] as? String, !urlString.isEmpty, let url = URL(string: urlString) else {
      reject("bad_args", "url is required", nil)
      return
    }
    var urlRequest = URLRequest(url: url)
    urlRequest.httpMethod = ((request["method"] as? String) ?? "GET").uppercased()
    urlRequest.timeoutInterval = ((request["timeoutMs"] as? NSNumber)?.doubleValue ?? 30_000) / 1000
    urlRequest.cachePolicy = .reloadIgnoringLocalCacheData
    if let headers = request["headers"] as? [String: Any] {
      for (name, value) in headers {
        // URLSession sets the length from the body itself.
        if name.caseInsensitiveCompare("Content-Length") == .orderedSame { continue }
        if let value = value as? String { urlRequest.setValue(value, forHTTPHeaderField: name) }
      }
    }
    if let bodyBase64 = request["bodyBase64"] as? String {
      guard let body = Data(base64Encoded: bodyBase64) else {
        reject("bad_args", "bodyBase64 is not base64", nil)
        return
      }
      urlRequest.httpBody = body
    }
    SecureSession.shared.dataTask(with: urlRequest) { data, response, error in
      if let error {
        reject("fetch_failed", error.localizedDescription, error)
        return
      }
      guard let http = response as? HTTPURLResponse else {
        reject("fetch_failed", "No HTTP response", nil)
        return
      }
      var headers: [String: String] = [:]
      for (name, value) in http.allHeaderFields {
        if let name = name as? String { headers[name] = "\(value)" }
      }
      resolve([
        "status": http.statusCode,
        "statusText": HTTPURLResponse.localizedString(forStatusCode: http.statusCode),
        "headers": headers,
        "bodyBase64": (data ?? Data()).base64EncodedString(),
      ])
    }.resume()
  }
}

/// The URLSession fetchSecure uses. Replaced when the certificate changes, so
/// no connection keeps a TLS session made with the old one.
private enum SecureSession {
  private static let lock = NSLock()
  private static var session: URLSession?

  static var shared: URLSession {
    lock.lock()
    defer { lock.unlock() }
    if let session { return session }
    let config = URLSessionConfiguration.ephemeral
    config.urlCache = nil
    let created = URLSession(configuration: config, delegate: SecureSessionDelegate(), delegateQueue: nil)
    session = created
    return created
  }

  static func reset() {
    lock.lock()
    let old = session
    session = nil
    lock.unlock()
    old?.finishTasksAndInvalidate()
  }
}

private final class SecureSessionDelegate: NSObject, URLSessionTaskDelegate {
  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodClientCertificate,
          let credential = ClientIdentityStore.credential() else {
      // Server trust and everything else: the system's own checks.
      completionHandler(.performDefaultHandling, nil)
      return
    }
    completionHandler(.useCredential, credential)
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    // Hand the 3xx back; JS follows only same-host hops (mayFollowRedirect).
    completionHandler(nil)
  }
}

enum ImportResult {
  case success(String)
  case wrongPassword
  case failure(String)
}

/// The picked identity: kept in the app's keychain, found again by its
/// persistent reference. The name and the intermediate certificates (public)
/// sit in UserDefaults.
enum ClientIdentityStore {
  private static let aliasKey = "bulwark.clientCert.alias"
  private static let refKey = "bulwark.clientCert.ref"
  private static let chainKey = "bulwark.clientCert.chain"

  static var alias: String? {
    UserDefaults.standard.string(forKey: aliasKey)
  }

  static func importPKCS12(_ data: Data, password: String) -> ImportResult {
    var items: CFArray?
    let options = [kSecImportExportPassphrase as String: password] as CFDictionary
    let status = SecPKCS12Import(data as CFData, options, &items)
    if status == errSecAuthFailed { return .wrongPassword }
    guard status == errSecSuccess,
          let first = (items as? [[String: Any]])?.first,
          let identityValue = first[kSecImportItemIdentity as String] else {
      return .failure("The file holds no certificate with a private key (\(status))")
    }
    let identity = identityValue as! SecIdentity
    var leaf: SecCertificate?
    guard SecIdentityCopyCertificate(identity, &leaf) == errSecSuccess, let leaf else {
      return .failure("The certificate could not be read")
    }
    let leafData = SecCertificateCopyData(leaf) as Data
    let name = (SecCertificateCopySubjectSummary(leaf) as String?) ?? "Client certificate"
    let chain = (first[kSecImportItemCertChain as String] as? [SecCertificate] ?? [])
      .map { SecCertificateCopyData($0) as Data }
      .filter { $0 != leafData }

    clear()
    let add: [String: Any] = [
      kSecValueRef as String: identity,
      kSecAttrLabel as String: name,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
      kSecReturnPersistentRef as String: true,
    ]
    var added: CFTypeRef?
    let addStatus = SecItemAdd(add as CFDictionary, &added)
    let ref: Data?
    if addStatus == errSecSuccess {
      ref = (added as? Data) ?? persistentRef(ofIdentityWith: leafData)
    } else if addStatus == errSecDuplicateItem {
      // Already in the keychain (picked before, or left by an earlier install).
      ref = persistentRef(ofIdentityWith: leafData)
    } else {
      return .failure("The certificate could not be stored (\(addStatus))")
    }
    guard let ref else { return .failure("The stored certificate could not be found") }
    let defaults = UserDefaults.standard
    defaults.set(ref, forKey: refKey)
    defaults.set(name, forKey: aliasKey)
    defaults.set(chain, forKey: chainKey)
    return .success(name)
  }

  static func clear() {
    let defaults = UserDefaults.standard
    if let ref = defaults.data(forKey: refKey) {
      let query: [String: Any] = [
        kSecClass as String: kSecClassIdentity,
        kSecValuePersistentRef as String: ref,
      ]
      SecItemDelete(query as CFDictionary)
    }
    defaults.removeObject(forKey: refKey)
    defaults.removeObject(forKey: aliasKey)
    defaults.removeObject(forKey: chainKey)
  }

  static func credential() -> URLCredential? {
    let defaults = UserDefaults.standard
    guard let ref = defaults.data(forKey: refKey) else { return nil }
    let query: [String: Any] = [
      kSecClass as String: kSecClassIdentity,
      kSecValuePersistentRef as String: ref,
      kSecReturnRef as String: true,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let item else { return nil }
    let identity = item as! SecIdentity
    let chain = (defaults.array(forKey: chainKey) as? [Data] ?? [])
      .compactMap { SecCertificateCreateWithData(nil, $0 as CFData) }
    return URLCredential(identity: identity, certificates: chain.isEmpty ? nil : chain, persistence: .forSession)
  }

  private static func persistentRef(ofIdentityWith certificateData: Data) -> Data? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassIdentity,
      kSecMatchLimit as String: kSecMatchLimitAll,
      kSecReturnRef as String: true,
      kSecReturnPersistentRef as String: true,
    ]
    var items: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &items) == errSecSuccess,
          let list = items as? [[String: Any]] else { return nil }
    for entry in list {
      guard let value = entry[kSecValueRef as String], let ref = entry[kSecValuePersistentRef as String] as? Data else { continue }
      var certificate: SecCertificate?
      guard SecIdentityCopyCertificate(value as! SecIdentity, &certificate) == errSecSuccess, let certificate else { continue }
      if SecCertificateCopyData(certificate) as Data == certificateData { return ref }
    }
    return nil
  }
}
