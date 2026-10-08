/* @metadata:begin
{"version":2,"rules":[{"id":"trip","name":"Trip forward","enabled":true,"matchType":"all","conditions":[{"field":"from","comparator":"domain_is","value":"client.example"}],"actions":[{"type":"forward","value":"deputy@example.com","keepCopy":true}],"stopProcessing":false,"activeFrom":"2026-10-05T06:00:00.000Z","activeUntil":"2026-10-16T16:00:00.000Z"},{"id":"news","name":"Newsletters","enabled":true,"matchType":"any","conditions":[{"field":"from","comparator":"contains","value":["news@","digest@"]},{"field":"subject","comparator":"starts_with","value":"Weekly"}],"actions":[{"type":"move","value":"INBOX/News","mailboxId":"mb-news"},{"type":"mark_read"}],"stopProcessing":true,"activeFrom":"2026-11-01T00:00:00.000Z"},{"id":"later","name":"Paused until","enabled":false,"matchType":"all","conditions":[{"field":"subject","comparator":"contains","value":"promo"}],"actions":[{"type":"discard"}],"stopProcessing":false,"activeUntil":"2026-12-31T23:00:00.000Z"},{"id":"boss","name":"Boss","enabled":true,"matchType":"all","conditions":[{"field":"from","comparator":"address_is","value":"boss@example.com"}],"actions":[{"type":"star"}],"stopProcessing":false}],"includeVacation":true,"vacationForward":{"enabled":true,"to":"colleague@example.com","keepCopy":true,"activeFrom":"2026-10-05T06:00:00.000Z","activeUntil":"2026-10-16T16:00:00.000Z"},"vacationAudience":{"only":"internal","domains":["example.com","example.org"]}}
@metadata:end */

require ["comparator-i;ascii-numeric", "copy", "date", "envelope", "fileinto", "imap4flags", "include", "mailbox", "mailboxid", "relational", "spamtestplus"];

# Vacation auto-reply
if envelope :domain :is "from" ["example.com", "example.org"] {
    include :personal :optional "vacation";
}

# Vacation forwarding
if allof(anyof(currentdate :zone "+0000" :value "gt" "date" "2026-10-05", allof(currentdate :zone "+0000" :is "date" "2026-10-05", currentdate :zone "+0000" :value "ge" "time" "06:00:00")), anyof(currentdate :zone "+0000" :value "lt" "date" "2026-10-16", allof(currentdate :zone "+0000" :is "date" "2026-10-16", currentdate :zone "+0000" :value "le" "time" "16:00:00")), not spamtest :percent :value "ge" :comparator "i;ascii-numeric" "50") {
    redirect :copy "colleague@example.com";
}

# Rule: Trip forward
if allof(anyof(currentdate :zone "+0000" :value "gt" "date" "2026-10-05", allof(currentdate :zone "+0000" :is "date" "2026-10-05", currentdate :zone "+0000" :value "ge" "time" "06:00:00")), anyof(currentdate :zone "+0000" :value "lt" "date" "2026-10-16", allof(currentdate :zone "+0000" :is "date" "2026-10-16", currentdate :zone "+0000" :value "le" "time" "16:00:00")), address :domain :is "From" "client.example") {
    redirect :copy "deputy@example.com";
}

# Rule: Newsletters
if allof(anyof(currentdate :zone "+0000" :value "gt" "date" "2026-11-01", allof(currentdate :zone "+0000" :is "date" "2026-11-01", currentdate :zone "+0000" :value "ge" "time" "00:00:00")), allof(anyof(header :contains "From" ["news@", "digest@"], header :matches "Subject" "Weekly*"), not spamtest :percent :value "ge" :comparator "i;ascii-numeric" "50")) {
    addflag "\\Seen";
    fileinto :mailboxid "mb-news" "INBOX/News";
    stop;
}

# Rule: Boss
if address :is "From" "boss@example.com" {
    addflag "\\Flagged";
}
