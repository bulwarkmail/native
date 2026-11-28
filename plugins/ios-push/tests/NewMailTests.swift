import Foundation

var failures = 0

func check(_ condition: Bool, _ name: String) {
  if condition {
    print("ok - \(name)")
  } else {
    failures += 1
    print("not ok - \(name)")
  }
}

func date(_ iso: String) -> Date {
  ISO8601DateFormatter().date(from: iso)!
}

let now = date("2026-11-24T12:00:00Z")

let mailboxAnswer: [[Any]] = [
  ["Mailbox/get", ["list": [
    ["id": "m-archive", "role": "archive", "unreadEmails": 9],
    ["id": "m-inbox", "role": "inbox", "unreadEmails": 3],
  ]], "0"],
]

let newestAnswer: [[Any]] = [
  ["Email/query", ["ids": ["e3", "e2", "e1"]], "0"],
  ["Email/get", ["list": [
    ["id": "e1", "threadId": "t1", "from": [["name": "", "email": "old@example.org"]], "subject": "Last week", "preview": "Old", "receivedAt": "2026-11-17T09:00:00Z"],
    ["id": "e3", "threadId": "t3", "from": [["name": "Ada Lovelace", "email": "ada@example.org"]], "subject": "Lunch?", "preview": "Are you free at one", "receivedAt": "2026-11-24T11:59:30Z"],
    ["id": "e2", "threadId": "t2", "from": [["email": "bob@example.org"]], "subject": "", "preview": "Draft notes", "receivedAt": "2026-11-24T11:58:00Z"],
  ]], "1"],
]

let inbox = Jmap.inbox(in: mailboxAnswer)
check(inbox?.id == "m-inbox" && inbox?.unread == 3, "finds the inbox and its unread count")
check(Jmap.inbox(in: [["Mailbox/get", ["list": [["id": "x", "role": "sent"]]], "0"]]) == nil, "no inbox, nothing to look in")

let newest = Jmap.emails(in: newestAnswer, order: Jmap.queryIds(in: newestAnswer))
check(newest.map(\.id) == ["e3", "e2", "e1"], "keeps the query's newest-first order")
check(newest.first?.sender == "Ada Lovelace" && newest.first?.subject == "Lunch?" && newest.first?.preview == "Are you free at one", "reads sender, subject and preview")
check(newest[1].sender == "bob@example.org", "falls back to the address without a name")
check(newest.first?.receivedAt == date("2026-11-24T11:59:30Z"), "reads when the message arrived")

let firstTime = NewMail.fresh(newest, notified: nil, now: now)
check(firstTime.map(\.id) == ["e3", "e2"], "a first push shows the mail that just came, not last week's unread")

let afterFirst = NewMail.noting(firstTime, in: nil)
check(afterFirst.ids == ["e3", "e2"] && afterFirst.newest == date("2026-11-24T11:59:30Z"), "remembers what it showed")
check(NewMail.fresh(newest, notified: afterFirst, now: now).isEmpty, "a push with nothing new shows no message again")

let laterAnswer: [[Any]] = [
  ["Email/query", ["ids": ["e4", "e3", "e2"]], "0"],
  ["Email/get", ["list": [
    ["id": "e4", "threadId": "t4", "from": [["name": "Cleo", "email": "cleo@example.org"]], "subject": "Invoice", "preview": "Attached", "receivedAt": "2026-11-24T15:00:00Z"],
    ["id": "e3", "threadId": "t3", "from": [["name": "Ada Lovelace", "email": "ada@example.org"]], "subject": "Lunch?", "preview": "Are you free at one", "receivedAt": "2026-11-24T11:59:30Z"],
    ["id": "e2", "threadId": "t2", "from": [["email": "bob@example.org"]], "subject": "", "preview": "Draft notes", "receivedAt": "2026-11-24T11:58:00Z"],
  ]], "1"],
]
let later = Jmap.emails(in: laterAnswer, order: Jmap.queryIds(in: laterAnswer))
check(NewMail.fresh(later, notified: afterFirst, now: date("2026-11-24T15:00:05Z")).map(\.id) == ["e4"], "hours later, only the new message")

let olderThanMark = [PushedEmail(id: "e9", threadId: "t9", sender: "Dan", subject: "Hi", preview: "", receivedAt: date("2026-11-24T11:57:00Z"))]
check(NewMail.fresh(olderThanMark, notified: afterFirst, now: now).map(\.id) == ["e9"], "mail that arrived a moment before the last one shown still counts")

let byIds: [[Any]] = [
  ["Email/get", ["list": [
    ["id": "e4", "threadId": "t4", "from": [["name": "Cleo", "email": "cleo@example.org"]], "subject": "Invoice", "preview": "Attached", "receivedAt": "2026-11-24T15:00:00Z"],
    ["id": "e4", "threadId": "t4", "from": [["name": "Other", "email": "x@example.org"]], "subject": "Dup", "preview": "", "receivedAt": "2026-11-24T15:00:00Z"],
  ]], "0"],
]
check(Jmap.emails(in: byIds, order: ["e5", "e4"]).map(\.sender) == ["Cleo"], "an id listed twice is shown once, missing ids are skipped")

var ring = NotifiedMail(ids: [], newest: nil)
for i in 0..<250 {
  ring = NewMail.noting([PushedEmail(id: "x\(i)", threadId: "", sender: "", subject: "", preview: "", receivedAt: nil)], in: ring)
}
check(ring.ids.count == NewMail.ringLimit && ring.ids.first == "x249", "remembers a bounded number of messages")

check(NewMail.mayCarryMail(["kind": "jmap-email-push", "emailIds": ["e1"]]), "an EmailPush is mail")
check(NewMail.mayCarryMail(["kind": "jmap-state-change", "changed": ["a": ["EmailDelivery": "s1"]]]), "an EmailDelivery change is mail")
check(NewMail.mayCarryMail(["kind": "jmap-state-change", "changed": [:] as [String: Any]]), "a change naming no type may be mail")
check(!NewMail.mayCarryMail(["kind": "jmap-state-change", "changed": ["a": ["ContactCard": "s1", "CalendarEvent": "s2"]]]), "a contacts and calendar change is not mail")
check(!NewMail.mayCarryMail(["kind": "jmap-state-change", "changed": ["a": ["Email": "s1"]]]), "an Email change without EmailDelivery is not new mail")
check(NewMail.mayCarryMail(["kind": "jmap-state-change", "changed": ["a": ["Email": "s1", "EmailDelivery": "s2"]]]), "an Email change with EmailDelivery is mail")
check(NewMail.mayCarryMail(["kind": "jmap-state-change", "changed": ["a": ["Email": "s1"], "b": ["Mailbox": "s2"]]]), "another account's mailbox change may be mail")

let suite = "bulwark.newmail.tests.\(UUID().uuidString)"
let defaults = UserDefaults(suiteName: suite)!
check(NewMail.read("acc/1", defaults: defaults) == nil, "nothing remembered for a new account")
NewMail.write(afterFirst, for: "acc/1", defaults: defaults)
check(NewMail.read("acc/1", defaults: defaults) == afterFirst, "what was shown survives the next push")
check(NewMail.read("acc-2", defaults: defaults) == nil, "each account remembers its own")
let firstPush = NewMail.claim(newest, key: "creds-a/acc", lookUp: true, now: now, defaults: defaults)
let secondPush = NewMail.claim(newest, key: "creds-a/acc", lookUp: true, now: now, defaults: defaults)
check(firstPush.map(\.id) == ["e3", "e2"] && secondPush.isEmpty, "a second push for the same mail shows it no more")
check(NewMail.claim(newest, key: "creds-b/acc", lookUp: true, now: now, defaults: defaults).map(\.id) == ["e3", "e2"], "another login with the same account id keeps its own record")
let byIdPush = NewMail.claim(later, key: "creds-c/acc", lookUp: false, now: now, defaults: defaults)
check(byIdPush.map(\.id) == ["e4", "e3", "e2"] && NewMail.claim(later, key: "creds-c/acc", lookUp: true, now: date("2026-11-24T15:00:05Z"), defaults: defaults).isEmpty, "mail shown from a push with ids is not shown again by a push without")
defaults.removePersistentDomain(forName: suite)

if failures > 0 {
  print("\(failures) failed")
  exit(1)
}
print("all passed")
