/* @metadata:begin
{"version":1,"rules":[{"id":"invoices","name":"Invoices","enabled":true,"matchType":"all","conditions":[{"field":"subject","comparator":"contains","value":["invoice","Rechnung"]}],"actions":[{"type":"move","value":"Finance/Invoices","mailboxId":"m12"},{"type":"star"},{"type":"add_label","value":"finance"}],"stopProcessing":false},{"id":"backup","name":"Backup","enabled":true,"matchType":"all","conditions":[{"field":"from","comparator":"contains","value":"news@example.com"}],"actions":[{"type":"copy","value":"Archive","mailboxId":"m7"}],"stopProcessing":false},{"id":"legacy","name":"Legacy path","enabled":true,"matchType":"all","conditions":[{"field":"from","comparator":"contains","value":"news@example.com"}],"actions":[{"type":"move","value":"Old/Path"}],"stopProcessing":false},{"id":"fwd","name":"Forward","enabled":true,"matchType":"all","conditions":[{"field":"from","comparator":"contains","value":"news@example.com"}],"actions":[{"type":"forward","value":"me@elsewhere.example","keepCopy":true}],"stopProcessing":false}]}
@metadata:end */

require ["copy", "fileinto", "imap4flags", "mailbox", "mailboxid"];

# Rule: Invoices
if header :contains "Subject" ["invoice", "Rechnung"] {
    addflag "\\Flagged";
    addflag "$label:finance";
    fileinto :mailboxid "m12" "Finance/Invoices";
}

# Rule: Backup
if header :contains "From" "news@example.com" {
    fileinto :copy :mailboxid "m7" "Archive";
}

# Rule: Legacy path
if header :contains "From" "news@example.com" {
    fileinto "Old/Path";
}

# Rule: Forward
if header :contains "From" "news@example.com" {
    redirect :copy "me@elsewhere.example";
}
