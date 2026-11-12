// "Save as template" from the composer (webmail
// components/templates/quick-save-template-dialog.tsx, #1506): the message
// as it stands, with just a name; HTML stays HTML.

import type { EmailTemplate } from '../stores/templates-store';
import { validateTemplateName } from './template-utils';

export type ComposerTemplate = Pick<EmailTemplate, 'name' | 'subject' | 'body' | 'isHTML' | 'category' | 'isFavorite'>;

export function templateFromComposer(message: {
  name: string;
  subject: string;
  body: string;
  plainTextMode: boolean;
}): { template: ComposerTemplate } | { error: 'empty' | 'too_long' } {
  const problem = validateTemplateName(message.name);
  if (problem) return { error: problem };
  return {
    template: {
      name: message.name.trim(),
      subject: message.subject,
      body: message.body,
      isHTML: !message.plainTextMode,
      category: '',
      isFavorite: false,
    },
  };
}
