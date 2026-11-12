// The address typed in the composer's link prompt (webmail
// components/email/link-dialog.tsx and rich-text-editor.tsx withLinkScheme).

/**
 * The link to insert: `url` with a scheme (https:// when none was typed),
 * none for an empty field or a bare "https://"; `error` when the address
 * holds a space, which no link can.
 */
export function linkPromptInput(value: string): { url?: string; error: boolean } {
  const address = value.trim();
  if (/\s/.test(address)) return { error: true };
  if (!address || /^https?:\/\/$/i.test(address)) return { error: false };
  const url = /^[a-z][a-z0-9+.-]*:/i.test(address) || address.startsWith('#') || address.startsWith('/')
    ? address
    : `https://${address}`;
  return { url, error: false };
}
