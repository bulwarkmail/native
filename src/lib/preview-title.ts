// The title a file preview shows. Webmail components/files/file-preview-modal.tsx:
// a message attached without a file name of its own gets one made up from its
// type or the download fallback ("Email.eml", "attachment"), so it is called
// by its subject instead.

/** A made-up name for a message part that came without one. */
export function isUnnamedMessagePart(name: string): boolean {
  return /^(attachment|email|download)(\.eml)?$/i.test(name.trim());
}

/** The header title for a previewed file: an unnamed message's subject, else its name. */
export function previewTitle(item: { kind: string; name: string; eml?: { subject?: string } }): string {
  if (item.kind === 'eml' && isUnnamedMessagePart(item.name)) {
    const subject = item.eml?.subject?.trim();
    if (subject) return subject;
  }
  return item.name;
}
