import SwiftUI
import WidgetKit

/// The iOS inbox widget: the active account's inbox unread count and newest
/// messages. The app writes what it shows (src/widgets/ios.ts) into the
/// keychain group it shares with its extensions and reloads the widget after
/// each write; a tap opens the app on the message through its deep link.

/// Kind the app reloads (BulwarkWidgetKit.swift).
let inboxWidgetKind = "BulwarkInbox"

/// src/widgets/ios.ts IosWidgetSnapshot.
struct InboxSnapshot: Decodable {
  struct Message: Decodable, Identifiable {
    let id: String
    let from: String
    let initials: String
    let color: String
    let subject: String
    let preview: String
    let receivedAt: Double
    let unread: Bool
    let url: String
  }

  struct Strings: Decodable {
    let inbox: String
    let unread: String
    let empty: String
    let signedOut: String
    let noSubject: String
  }

  let version: Int
  let generatedAt: Double
  let signedIn: Bool
  let theme: String
  let locale: String
  let hour12: Bool
  let account: String?
  let unread: Int
  let inboxUrl: String
  let composeUrl: String
  let messages: [Message]
  let strings: Strings

  /// IOS_WIDGET_KEY in src/widgets/ios.ts.
  static func load() -> InboxSnapshot? {
    guard let data = SharedKeychain.read("bulwark_widget_inbox") else { return nil }
    return try? JSONDecoder().decode(InboxSnapshot.self, from: data)
  }
}

struct InboxEntry: TimelineEntry {
  let date: Date
  let snapshot: InboxSnapshot?
}

struct InboxProvider: TimelineProvider {
  func placeholder(in context: Context) -> InboxEntry {
    InboxEntry(date: Date(), snapshot: nil)
  }

  func getSnapshot(in context: Context, completion: @escaping (InboxEntry) -> Void) {
    completion(InboxEntry(date: Date(), snapshot: InboxSnapshot.load()))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<InboxEntry>) -> Void) {
    let entry = InboxEntry(date: Date(), snapshot: InboxSnapshot.load())
    // The app reloads the widget when it writes new data; this only keeps
    // "today" and the times current.
    completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(30 * 60))))
  }
}

/// The widget palette of src/widgets/theme.ts, roughly.
struct Palette {
  let background: Color
  let foreground: Color
  let muted: Color
  let accent: Color

  init(dark: Bool) {
    background = dark ? Color(hex: "#18181b") : Color(hex: "#ffffff")
    foreground = dark ? Color(hex: "#fafafa") : Color(hex: "#09090b")
    muted = dark ? Color(hex: "#a1a1aa") : Color(hex: "#71717a")
    accent = Color(hex: "#db2d54")
  }
}

extension Color {
  init(hex: String) {
    var value: UInt64 = 0
    Scanner(string: hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))).scanHexInt64(&value)
    self.init(
      red: Double((value >> 16) & 0xff) / 255,
      green: Double((value >> 8) & 0xff) / 255,
      blue: Double(value & 0xff) / 255
    )
  }
}

extension View {
  /// iOS 17 wants the background declared and adds the margins itself.
  @ViewBuilder func widgetBackground(_ color: Color) -> some View {
    if #available(iOS 17.0, *) {
      containerBackground(for: .widget) { color }
    } else {
      padding(14).background(color)
    }
  }
}

func listTime(_ ms: Double, locale: String, hour12: Bool) -> String {
  let date = Date(timeIntervalSince1970: ms / 1000)
  let formatter = DateFormatter()
  formatter.locale = Locale(identifier: locale)
  if Calendar.current.isDateInToday(date) {
    formatter.dateFormat = hour12 ? "h:mm a" : "HH:mm"
  } else {
    formatter.setLocalizedDateFormatFromTemplate("MMMd")
  }
  return formatter.string(from: date)
}

struct MessageRow: View {
  let message: InboxSnapshot.Message
  let time: String
  let palette: Palette

  var body: some View {
    HStack(spacing: 8) {
      ZStack {
        Circle().fill(Color(hex: message.color))
        Text(message.initials)
          .font(.system(size: 11, weight: .semibold))
          .foregroundColor(.white)
      }
      .frame(width: 26, height: 26)
      VStack(alignment: .leading, spacing: 1) {
        HStack(spacing: 4) {
          Text(message.from)
            .font(.system(size: 13, weight: message.unread ? .semibold : .regular))
            .foregroundColor(palette.foreground)
            .lineLimit(1)
          Spacer(minLength: 4)
          Text(time)
            .font(.system(size: 11))
            .foregroundColor(message.unread ? palette.accent : palette.muted)
        }
        Text(message.subject)
          .font(.system(size: 12))
          .foregroundColor(message.unread ? palette.foreground : palette.muted)
          .lineLimit(1)
      }
    }
  }
}

struct InboxWidgetView: View {
  @Environment(\.widgetFamily) private var family
  @Environment(\.colorScheme) private var systemScheme
  let entry: InboxEntry

  private var dark: Bool {
    switch entry.snapshot?.theme {
    case "dark": return true
    case "light": return false
    default: return systemScheme == .dark
    }
  }

  private var rows: Int {
    switch family {
    case .systemSmall: return 1
    case .systemMedium: return 2
    default: return 6
    }
  }

  var body: some View {
    let palette = Palette(dark: dark)
    content(palette)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .widgetBackground(palette.background)
      .widgetURL(URL(string: entry.snapshot?.inboxUrl ?? "bulwarkmobile://mail/folder/inbox"))
  }

  @ViewBuilder private func content(_ palette: Palette) -> some View {
    if let snapshot = entry.snapshot, snapshot.signedIn {
      VStack(alignment: .leading, spacing: family == .systemSmall ? 6 : 8) {
        header(snapshot, palette)
        if snapshot.messages.isEmpty {
          Spacer(minLength: 0)
          Text(snapshot.strings.empty)
            .font(.system(size: 13))
            .foregroundColor(palette.muted)
          Spacer(minLength: 0)
        } else {
          ForEach(snapshot.messages.prefix(rows)) { message in
            let row = MessageRow(
              message: message,
              time: listTime(message.receivedAt, locale: snapshot.locale, hour12: snapshot.hour12),
              palette: palette
            )
            // A small widget opens what it shows through widgetURL alone.
            if family != .systemSmall, let url = URL(string: message.url) {
              Link(destination: url) { row }
            } else {
              row
            }
          }
          Spacer(minLength: 0)
        }
      }
    } else {
      VStack(alignment: .leading, spacing: 6) {
        Text("Bulwark Mail")
          .font(.system(size: 15, weight: .semibold))
          .foregroundColor(palette.foreground)
        Text(entry.snapshot?.strings.signedOut ?? "Open Bulwark to load your inbox.")
          .font(.system(size: 13))
          .foregroundColor(palette.muted)
      }
    }
  }

  private func header(_ snapshot: InboxSnapshot, _ palette: Palette) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      VStack(alignment: .leading, spacing: 0) {
        Text(snapshot.strings.inbox)
          .font(.system(size: 15, weight: .semibold))
          .foregroundColor(palette.foreground)
        if let account = snapshot.account, family != .systemSmall {
          Text(account)
            .font(.system(size: 11))
            .foregroundColor(palette.muted)
            .lineLimit(1)
        }
      }
      Spacer(minLength: 4)
      if snapshot.unread > 0 {
        Text("\(snapshot.unread)")
          .font(.system(size: family == .systemSmall ? 22 : 15, weight: .bold))
          .foregroundColor(palette.accent)
          .accessibilityLabel("\(snapshot.unread) \(snapshot.strings.unread)")
      }
    }
  }
}

struct InboxWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: inboxWidgetKind, provider: InboxProvider()) { entry in
      InboxWidgetView(entry: entry)
    }
    .configurationDisplayName("Inbox")
    .description("Unread mail and the newest messages.")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
  }
}

@main
struct BulwarkWidgets: WidgetBundle {
  var body: some Widget {
    InboxWidget()
  }
}
