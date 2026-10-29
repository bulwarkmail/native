/* @metadata:begin
{"version":1,"rules":[{"id":"anna","name":"Anna  exactly","enabled":true,"matchType":"any","conditions":[{"field":"from","comparator":"address_is","value":"anna@acme.com"},{"field":"cc","comparator":"address_is","value":["anna@acme.com","a.smith@acme.com"]}],"actions":[{"type":"star"}],"stopProcessing":false},{"id":"acme","name":"Acme domain","enabled":true,"matchType":"all","conditions":[{"field":"to","comparator":"domain_is","value":"acme.com"}],"actions":[{"type":"add_label","value":"acme"}],"stopProcessing":false},{"id":"drop","name":"Drop spam   sender","enabled":true,"matchType":"all","conditions":[{"field":"from","comparator":"domain_is","value":"spam.example"}],"actions":[{"type":"discard"}],"stopProcessing":true},{"id":"bounce","name":"Bounce","enabled":true,"matchType":"all","conditions":[{"field":"subject","comparator":"is","value":"win money"}],"actions":[{"type":"reject","value":"No thanks"}],"stopProcessing":true},{"id":"every","name":"Everything else","enabled":true,"matchType":"all","conditions":[{"field":"all","comparator":"any","value":""}],"actions":[{"type":"add_label","value":"seen-by-filter"}],"stopProcessing":false}]}
@metadata:end */

require ["imap4flags", "reject"];

# Rule: Anna exactly
if anyof(address :is "From" "anna@acme.com", address :is "Cc" ["anna@acme.com", "a.smith@acme.com"]) {
    addflag "\\Flagged";
}

# Rule: Acme domain
if address :domain :is "To" "acme.com" {
    addflag "$label:acme";
}

# Rule: Drop spam sender
if address :domain :is "From" "spam.example" {
    discard;
    stop;
}

# Rule: Bounce
if header :is "Subject" "win money" {
    reject "No thanks";
    stop;
}

# Rule: Everything else
if true {
    addflag "$label:seen-by-filter";
}
