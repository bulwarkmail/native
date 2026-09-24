/* @metadata:begin
{"version":1,"rules":[{"id":"invoices","name":"Invoices","enabled":true,"matchType":"all","conditions":[{"field":"subject","comparator":"contains","value":"invoice"},{"field":"attachment","comparator":"has_type","value":["pdf","xml"]}],"actions":[{"type":"move","value":"Finance","mailboxId":"m3"},{"type":"mark_read"}],"stopProcessing":true},{"id":"vip","name":"VIP","enabled":true,"matchType":"all","conditions":[{"field":"from","comparator":"is","value":"ceo@example.com"}],"actions":[{"type":"keep"},{"type":"star"}],"stopProcessing":false},{"id":"fwd","name":"Forward copy","enabled":true,"matchType":"all","conditions":[{"field":"from","comparator":"contains","value":"news@example.com"}],"actions":[{"type":"forward","value":"assistant@example.com","keepCopy":true}],"stopProcessing":false},{"id":"spam","name":"Spam too","enabled":true,"matchType":"all","conditions":[{"field":"from","comparator":"contains","value":"news@example.com"}],"actions":[{"type":"copy","value":"Everything","mailboxId":"m9"}],"stopProcessing":false,"includeSpam":true},{"id":"big","name":"Big mail","enabled":true,"matchType":"all","conditions":[{"field":"size","comparator":"greater_than","value":"10000000"}],"actions":[{"type":"reject","value":"Too \"big\""}],"stopProcessing":false}],"includeVacation":true}
@metadata:end */

require ["comparator-i;ascii-numeric", "copy", "fileinto", "imap4flags", "include", "mailbox", "mailboxid", "mime", "reject", "relational", "spamtestplus"];

# Vacation auto-reply
include :personal :optional "vacation";

# Rule: Invoices
if allof(header :contains "Subject" "invoice", header :mime :anychild :matches ["Content-Disposition", "Content-Type"] ["*.pdf*", "*.xml*"], not spamtest :percent :value "ge" :comparator "i;ascii-numeric" "50") {
    addflag "\\Seen";
    fileinto :mailboxid "m3" "Finance";
    stop;
}

# Rule: VIP
if header :is "From" "ceo@example.com" {
    addflag "\\Flagged";
    fileinto "INBOX";
}

# Rule: Forward copy
if header :contains "From" "news@example.com" {
    redirect :copy "assistant@example.com";
}

# Rule: Spam too
if header :contains "From" "news@example.com" {
    fileinto :copy :mailboxid "m9" "Everything";
}

# Rule: Big mail
if size :over 10000000 {
    reject "Too \"big\"";
}

# --- External rules (managed outside Bulwark) ---


# Hand-written rule
if header :contains "X-Spam-Flag" "YES" {
    fileinto "Junk";
    stop;
}
