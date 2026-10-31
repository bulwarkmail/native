// Buttons repeated on every row of a list read the same to a screen reader:
// TalkBack heard "Delete tag" on each tag in Settings > Tags and "Remove
// access" on each person a file is shared with, without saying whose. They
// carry the row's name now (webmail keyword-settings.tsx: "Delete {name}").
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').split('\r\n').join('\n');

describe('per-row buttons', () => {
  it('name the tag they edit or delete', () => {
    const source = read('components/settings/KeywordSettings.tsx');
    expect(source).toContain("t('settings.keywords.delete_tag', 'Delete {name}', { name: kw.label })");
    expect(source).toContain("t('settings.keywords.edit_tag', 'Edit {name}', { name: kw.label })");
    expect(source).not.toMatch(/accessibilityLabel=\{t\('settings\.keywords\.(delete|edit)',/);
  });

  it('name the person whose file access they remove', () => {
    const source = read('components/files/ShareSheet.tsx');
    expect(source).toContain("t('files.share_remove_for', 'Remove access for {name}', { name: principalName(principalId) })");
    expect(source).not.toMatch(/accessibilityLabel=\{t\('files\.share_remove', 'Remove access'\)\}/);
  });

  it('name the delegate they change or remove', () => {
    const source = read('components/settings/DelegateSettings.tsx');
    expect(source).toContain("accessibilityLabel={t('delegates.remove_for', 'Remove access for {name}', { name: display.name })}");
    expect(source).toContain("accessibilityLabel={t('delegates.dialog_title_change', 'Change access for {name}', { name: display.name })}");
  });
});
