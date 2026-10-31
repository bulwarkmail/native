// What a screen reader says for the cross on a To/Cc/Bcc chip. It said only
// "Remove", so with several chips nobody could tell which one a cross took
// away. The webmail names the recipient (email-composer.tsx,
// recipient_remove_named), as the event editor here already does.

type Translate = (key: string, fallback?: string, params?: Record<string, string | number>) => string;

/** "Remove Anna Berg", or "Remove anna@example.org" when the chip has no name. */
export function recipientRemoveAccessibilityLabel(
  recipient: { name?: string; email: string },
  t: Translate,
): string {
  const name = recipient.name?.trim() || recipient.email.trim();
  if (!name) return t('email_composer.recipient_remove', 'Remove');
  return t('email_composer.recipient_remove_named', 'Remove {name}', { name });
}
