/* @metadata:begin
{"version":1,"rules":[{"id":"news","name":"Newsletters","enabled":true,"matchType":"all","conditions":[{"field":"from","comparator":"contains","value":"news@example.com"}],"actions":[{"type":"mark_read"},{"type":"move","value":"Newsletters"}],"stopProcessing":false},{"id":"boss","name":"Boss","enabled":true,"matchType":"all","conditions":[{"field":"from","comparator":"is","value":"boss@example.com"}],"actions":[{"type":"keep"}],"stopProcessing":true}],"includeVacation":true}
@metadata:end */

require ["fileinto", "imap4flags", "include"];

# Vacation auto-reply
include :personal :optional "vacation";

# Rule: Newsletters
if header :contains "From" "news@example.com" {
    addflag "\\Seen";
    fileinto "Newsletters";
}

# Rule: Boss
if header :is "From" "boss@example.com" {
    fileinto "INBOX";
    stop;
}
