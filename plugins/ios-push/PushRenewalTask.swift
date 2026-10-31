import BackgroundTasks
import Foundation
import UIKit

/// The app's side of PushRenewal: every shared account's subscription is
/// renewed when the app comes back to the foreground (the JS refresh runs
/// only on a cold start), and from a background app refresh task that iOS
/// runs now and then while the app is not used at all.
///
/// The config plugin (plugins/ios-push/index.js) compiles this into the app,
/// calls register() from AppDelegate's didFinishLaunching (BGTaskScheduler
/// wants its handlers registered before launch ends), and lists the task id
/// in Info.plist (BGTaskSchedulerPermittedIdentifiers, UIBackgroundModes
/// fetch).
enum PushRenewalTask {
  static let identifier = "org.bulwarkmail.mobile.push-renewal"
  /// A subscription lasts seven days; asking twice a day leaves iOS room to
  /// skip runs (it decides when, and whether, the task runs).
  static let interval: TimeInterval = 12 * 60 * 60
  private static var observers: [NSObjectProtocol] = []

  static func register() {
    let registered = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
      guard let refresh = task as? BGAppRefreshTask else {
        task.setTaskCompleted(success: false)
        return
      }
      handle(refresh)
    }
    if !registered { pushLog.error("push renewal task not registered") }
    let center = NotificationCenter.default
    observers = [
      center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: nil) { _ in
        // No token refresh here: the app's own code refreshes on foreground.
        Task { await PushRenewal.renewAll(allowRefresh: false) }
      },
      center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { _ in
        schedule()
      },
    ]
  }

  static func schedule() {
    let request = BGAppRefreshTaskRequest(identifier: identifier)
    request.earliestBeginDate = Date(timeIntervalSinceNow: interval)
    do {
      try BGTaskScheduler.shared.submit(request)
    } catch {
      // The simulator has no background refresh.
      pushLog.error("push renewal task not scheduled: \(String(describing: error), privacy: .public)")
    }
  }

  private static func handle(_ task: BGAppRefreshTask) {
    schedule()
    let work = Task {
      await PushRenewal.renewAll(allowRefresh: true)
      task.setTaskCompleted(success: !Task.isCancelled)
    }
    task.expirationHandler = { work.cancel() }
  }
}
