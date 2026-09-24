/* @metadata:begin
{"version":1,"rules":[{"id":"one","name":"Single condition","enabled":true,"matchType":"all","conditions":[{"field":"from","comparator":"contains","value":"news@example.com"}],"actions":[{"type":"move","value":"Newsletters"}],"stopProcessing":false},{"id":"all","name":"All of two","enabled":true,"matchType":"all","conditions":[{"field":"from","comparator":"contains","value":"a@example.com"},{"field":"subject","comparator":"contains","value":"report"}],"actions":[{"type":"move","value":"Newsletters"}],"stopProcessing":false},{"id":"any","name":"Any of two","enabled":true,"matchType":"any","conditions":[{"field":"from","comparator":"contains","value":"a@example.com"},{"field":"subject","comparator":"contains","value":"report"}],"actions":[{"type":"copy","value":"Reports"}],"stopProcessing":false},{"id":"optin","name":"Spam too","enabled":true,"matchType":"all","conditions":[{"field":"from","comparator":"contains","value":"news@example.com"}],"actions":[{"type":"move","value":"Newsletters"}],"stopProcessing":false,"includeSpam":true},{"id":"keep","name":"Allow list","enabled":true,"matchType":"all","conditions":[{"field":"from","comparator":"contains","value":"news@example.com"}],"actions":[{"type":"keep"}],"stopProcessing":false},{"id":"off","name":"Disabled","enabled":false,"matchType":"all","conditions":[{"field":"from","comparator":"contains","value":"news@example.com"}],"actions":[{"type":"move","value":"Newsletters"}],"stopProcessing":false}]}
@metadata:end */

require ["comparator-i;ascii-numeric", "copy", "fileinto", "relational", "spamtestplus"];

# Rule: Single condition
if allof(header :contains "From" "news@example.com", not spamtest :percent :value "ge" :comparator "i;ascii-numeric" "50") {
    fileinto "Newsletters";
}

# Rule: All of two
if allof(header :contains "From" "a@example.com", header :contains "Subject" "report", not spamtest :percent :value "ge" :comparator "i;ascii-numeric" "50") {
    fileinto "Newsletters";
}

# Rule: Any of two
if allof(anyof(header :contains "From" "a@example.com", header :contains "Subject" "report"), not spamtest :percent :value "ge" :comparator "i;ascii-numeric" "50") {
    fileinto :copy "Reports";
}

# Rule: Spam too
if header :contains "From" "news@example.com" {
    fileinto "Newsletters";
}

# Rule: Allow list
if header :contains "From" "news@example.com" {
    fileinto "INBOX";
}
