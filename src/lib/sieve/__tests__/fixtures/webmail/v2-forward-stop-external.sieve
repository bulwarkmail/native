/* @metadata:begin
{"version":2,"rules":[{"id":"invoices","name":"Invoices","enabled":true,"matchType":"all","conditions":[{"field":"subject","comparator":"contains","value":"Invoice"}],"actions":[{"type":"move","value":"INBOX/Invoices","mailboxId":"mb-inv"}],"stopProcessing":true,"activeUntil":"2026-12-31T23:00:00.000Z"},{"id":"vip","name":"VIP","enabled":true,"matchType":"all","conditions":[{"field":"from","comparator":"address_is","value":"vip@example.com"}],"actions":[{"type":"star"}],"stopProcessing":false}],"includeVacation":true,"vacationForward":{"enabled":true,"to":"colleague@example.com","keepCopy":false,"activeFrom":"2026-10-05T06:00:00.000Z","activeUntil":"2026-10-16T16:00:00.000Z"},"vacationAudience":{"only":"external","domains":["example.com","example.org"]}}
@metadata:end */

require ["comparator-i;ascii-numeric", "date", "envelope", "fileinto", "imap4flags", "include", "mailbox", "mailboxid", "relational", "spamtestplus"];

# Vacation auto-reply
if not envelope :domain :is "from" ["example.com", "example.org"] {
    include :personal :optional "vacation";
}

# Vacation forwarding
if allof(anyof(currentdate :zone "+0000" :value "gt" "date" "2026-10-05", allof(currentdate :zone "+0000" :is "date" "2026-10-05", currentdate :zone "+0000" :value "ge" "time" "06:00:00")), anyof(currentdate :zone "+0000" :value "lt" "date" "2026-10-16", allof(currentdate :zone "+0000" :is "date" "2026-10-16", currentdate :zone "+0000" :value "le" "time" "16:00:00")), not spamtest :percent :value "ge" :comparator "i;ascii-numeric" "50") {
    redirect "colleague@example.com";
    stop;
}

# Rule: Invoices
if allof(anyof(currentdate :zone "+0000" :value "lt" "date" "2026-12-31", allof(currentdate :zone "+0000" :is "date" "2026-12-31", currentdate :zone "+0000" :value "le" "time" "23:00:00")), allof(header :contains "Subject" "Invoice", not spamtest :percent :value "ge" :comparator "i;ascii-numeric" "50")) {
    fileinto :mailboxid "mb-inv" "INBOX/Invoices";
    stop;
}

# Rule: VIP
if address :is "From" "vip@example.com" {
    addflag "\\Flagged";
}

# --- External rules (managed outside Bulwark) ---


# Hand-written rule
if header :contains "X-Spam-Flag" "YES" {
    fileinto "Junk";
    stop;
}
