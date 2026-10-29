/* @metadata:begin
{"version":1,"rules":[{"id":"news","name":"News","enabled":true,"matchType":"all","conditions":[{"field":"from","comparator":"contains","value":"news@"}],"actions":[{"type":"mark_read"}],"stopProcessing":false}],"includeVacation":true,"vacationForward":{"enabled":false,"to":"backup@example.org","keepCopy":true}}
@metadata:end */

require ["imap4flags", "include"];

# Vacation auto-reply
include :personal :optional "vacation";

# Rule: News
if header :contains "From" "news@" {
    addflag "\\Seen";
}
