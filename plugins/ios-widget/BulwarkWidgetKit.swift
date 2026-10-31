import Foundation
import React
import WidgetKit

/// Lets the app redraw its WidgetKit widget (plugins/ios-widget) after it
/// wrote new data (src/widgets/ios.ts), and ask whether one is placed at all,
/// so it doesn't build a snapshot nobody sees.
@objc(BulwarkWidgetKit)
final class BulwarkWidgetKit: NSObject {
  /// inboxWidgetKind in BulwarkWidget.swift.
  static let inboxKind = "BulwarkInbox"

  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc(reloadAll:rejecter:)
  func reloadAll(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    WidgetCenter.shared.reloadTimelines(ofKind: BulwarkWidgetKit.inboxKind)
    resolve(nil)
  }

  @objc(placedCount:rejecter:)
  func placedCount(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    WidgetCenter.shared.getCurrentConfigurations { result in
      switch result {
      case .success(let widgets):
        resolve(widgets.filter { $0.kind == BulwarkWidgetKit.inboxKind }.count)
      case .failure(let error):
        reject("widgetkit", error.localizedDescription, error)
      }
    }
  }
}
