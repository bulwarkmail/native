require ["fileinto", "imap4flags"];

# Sorted by hand
if header :contains "from" "boss@example.org" {
    addflag "\\Flagged";
    fileinto "Work";
} elsif header :contains "list-id" "lists.example.org" {
    fileinto "Lists";
}
# Everything else stays in the inbox
else {
    keep;
}

# end of my rules
