/* @metadata:begin
{"version":1,"rules":[{"id":"invoices","name":"Invoices","enabled":true,"matchType":"all","conditions":[{"field":"subject","comparator":"contains","value":"Invoice"}],"actions":[{"type":"move","value":"INBOX/Invoices","mailboxId":"mb-inv"}],"stopProcessing":true},{"id":"vip","name":"VIP","enabled":true,"matchType":"all","conditions":[{"field":"from","comparator":"address_is","value":"vip@example.com"}],"actions":[{"type":"star"}],"stopProcessing":false}],"includeVacation":true,"vacationForward":{"enabled":false,"to":"colleague@example.com","keepCopy":false,"activeFrom":"2026-10-05T06:00:00.000Z","activeUntil":"2026-10-16T16:00:00.000Z"}}
@metadata:end */

require ["comparator-i;ascii-numeric", "fileinto", "imap4flags", "include", "mailbox", "mailboxid", "relational", "spamtestplus"];

# Vacation auto-reply
include :personal :optional "vacation";

# Rule: Invoices
if allof(header :contains "Subject" "Invoice", not spamtest :percent :value "ge" :comparator "i;ascii-numeric" "50") {
    fileinto :mailboxid "mb-inv" "INBOX/Invoices";
    stop;
}

# Rule: VIP
if address :is "From" "vip@example.com" {
    addflag "\\Flagged";
}
