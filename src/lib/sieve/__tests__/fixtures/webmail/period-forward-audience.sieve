/* @metadata:begin
{"version":2,"rules":[{"id":"trip","name":"While travelling","enabled":true,"matchType":"all","conditions":[{"field":"from","comparator":"domain_is","value":"client.example"}],"actions":[{"type":"forward","value":"deputy@example.org","keepCopy":true}],"stopProcessing":false,"activeFrom":"2026-11-02T07:00:00.000Z","activeUntil":"2026-11-13T17:30:00.000Z"},{"id":"later","name":"From December","enabled":true,"matchType":"all","conditions":[{"field":"subject","comparator":"contains","value":"report"}],"actions":[{"type":"move","value":"Reports","mailboxId":"m7"}],"stopProcessing":true,"activeFrom":"2026-12-01T00:00:00.000Z"}],"includeVacation":true,"vacationForward":{"enabled":true,"to":"backup@example.org","keepCopy":false,"activeFrom":"2026-11-02T00:00:00.000Z","activeUntil":"2026-11-14T00:00:00.000Z"},"vacationAudience":{"only":"internal","domains":["example.org","example.com"]}}
@metadata:end */

require ["comparator-i;ascii-numeric", "copy", "date", "envelope", "fileinto", "include", "mailbox", "mailboxid", "relational", "spamtestplus"];

# Vacation auto-reply
if envelope :domain :is "from" ["example.org", "example.com"] {
    include :personal :optional "vacation";
}

# Vacation forwarding
if allof(anyof(currentdate :zone "+0000" :value "gt" "date" "2026-11-02", allof(currentdate :zone "+0000" :is "date" "2026-11-02", currentdate :zone "+0000" :value "ge" "time" "00:00:00")), anyof(currentdate :zone "+0000" :value "lt" "date" "2026-11-14", allof(currentdate :zone "+0000" :is "date" "2026-11-14", currentdate :zone "+0000" :value "le" "time" "00:00:00")), not spamtest :percent :value "ge" :comparator "i;ascii-numeric" "50") {
    redirect "backup@example.org";
    stop;
}

# Rule: While travelling
if allof(anyof(currentdate :zone "+0000" :value "gt" "date" "2026-11-02", allof(currentdate :zone "+0000" :is "date" "2026-11-02", currentdate :zone "+0000" :value "ge" "time" "07:00:00")), anyof(currentdate :zone "+0000" :value "lt" "date" "2026-11-13", allof(currentdate :zone "+0000" :is "date" "2026-11-13", currentdate :zone "+0000" :value "le" "time" "17:30:00")), address :domain :is "From" "client.example") {
    redirect :copy "deputy@example.org";
}

# Rule: From December
if allof(anyof(currentdate :zone "+0000" :value "gt" "date" "2026-12-01", allof(currentdate :zone "+0000" :is "date" "2026-12-01", currentdate :zone "+0000" :value "ge" "time" "00:00:00")), allof(header :contains "Subject" "report", not spamtest :percent :value "ge" :comparator "i;ascii-numeric" "50")) {
    fileinto :mailboxid "m7" "Reports";
    stop;
}
