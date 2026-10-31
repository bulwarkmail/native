import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The template picker in the composer (a component the node test environment
// can't render). With no templates it said "No templates yet" and offered
// no way on (webmail 19676a14f: "Manage" in the template picker).
const source = fs.readFileSync(path.resolve(__dirname, '../../components/TemplateSheet.tsx'), 'utf8');

describe('TemplateSheet', () => {
  it('offers "Manage templates", which opens the template manager in place of the list', () => {
    const manage = source.slice(source.indexOf("t('templates.manage'") - 400, source.indexOf("t('templates.manage'"));
    expect(manage).toMatch(/onPress=\{\(\) => setManaging\(true\)\}/);
    expect(source).toMatch(/\{managing && \([\s\S]*?<TemplateSettings \/>/);
  });

  it('leaves the manager for the list on back, and opens on the list', () => {
    expect(source).toMatch(/onRequestClose=\{managing \? \(\) => setManaging\(false\) : onClose\}/);
    expect(source).toMatch(/if \(visible\) \{\s+setQuery\(''\);\s+setManaging\(false\);/);
  });
});
