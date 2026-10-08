/* @metadata:begin
{"version":2,"rules":[{"id":"invoices","name":"Invoices","enabled":true,"matchType":"all","conditions":[{"field":"subject","comparator":"contains","value":"Invoice"}],"actions":[{"type":"move","value":"INBOX/Invoices","mailboxId":"mb-inv"}],"stopProcessing":true,"activeUntil":"2026-12-31T23:00:00.000Z"},{"id":"vip","name":"VIP","enabled":true,"matchType":"all","conditions":[{"field":"from","comparator":"address_is","value":"vip@example.com"}],"actions":[{"type":"star"}],"stopProcessing":false}],"vacationForward":{"enabled":true,"to":"colleague@example.com","keepCopy":true}}
@metadata:end */

require ["comparator-i;ascii-numeric", "copy", "date", "fileinto", "imap4flags", "mailbox", "mailboxid", "relational", "spamtestplus"];

# Vacation forwarding
if not spamtest :percent :value "ge" :comparator "i;ascii-numeric" "50" {
    redirect :copy "colleague@example.com";
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
