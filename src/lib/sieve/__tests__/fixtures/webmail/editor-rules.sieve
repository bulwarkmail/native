/* @metadata:begin
{"version":2,"rules":[{"id":"r-body","name":"Body does not contain unsubscribe","enabled":true,"matchType":"all","conditions":[{"field":"body","comparator":"not_contains","value":"unsubscribe"},{"field":"from","comparator":"domain_is","value":"example.com"}],"actions":[{"type":"add_label","value":"personal"}],"stopProcessing":false},{"id":"r-body-patterns","name":"Body patterns","enabled":true,"matchType":"any","conditions":[{"field":"body","comparator":"starts_with","value":"Dear"},{"field":"body","comparator":"ends_with","value":["Regards","Cheers"]},{"field":"body","comparator":"matches","value":"order *"},{"field":"body","comparator":"not_is","value":"x"}],"actions":[{"type":"mark_read"}],"stopProcessing":false},{"id":"r-delivered","name":"Shop alias","enabled":true,"matchType":"all","conditions":[{"field":"delivered_to","comparator":"address_is","value":["shop@example.org","news@example.org"]}],"actions":[{"type":"move","mailboxId":"b","value":"Shopping"}],"stopProcessing":true},{"id":"r-attach","name":"Has an attachment → Star, + Receipts","enabled":true,"matchType":"all","conditions":[{"field":"attachment","comparator":"has_any","value":""},{"field":"size","comparator":"greater_than","value":"2M"}],"actions":[{"type":"star"},{"type":"copy","mailboxId":"c","value":"Receipts"},{"type":"move","mailboxId":"d","value":"Archive"}],"stopProcessing":false},{"id":"r-skip","name":"Skipped rule","enabled":false,"matchType":"all","conditions":[{"field":"attachment","comparator":"has_type","value":["pdf","docx"]}],"actions":[{"type":"discard"}],"stopProcessing":false}]}
@metadata:end */

require ["body", "comparator-i;ascii-numeric", "copy", "envelope", "fileinto", "imap4flags", "mailbox", "mailboxid", "mime", "relational", "spamtestplus"];

# Rule: Body does not contain unsubscribe
if allof(not body :contains "unsubscribe", address :domain :is "From" "example.com") {
    addflag "$label:personal";
}

# Rule: Body patterns
if anyof(body :matches "Dear*", body :matches ["*Regards", "*Cheers"], body :matches "order *", not body :is "x") {
    addflag "\\Seen";
}

# Rule: Shop alias
if allof(envelope :is "to" ["shop@example.org", "news@example.org"], not spamtest :percent :value "ge" :comparator "i;ascii-numeric" "50") {
    fileinto :mailboxid "b" "Shopping";
    stop;
}

# Rule: Has an attachment → Star, + Receipts
if allof(header :mime :anychild :contains "Content-Disposition" "attachment", size :over 2M, not spamtest :percent :value "ge" :comparator "i;ascii-numeric" "50") {
    addflag "\\Flagged";
    fileinto :copy :mailboxid "c" "Receipts";
    fileinto :mailboxid "d" "Archive";
}
