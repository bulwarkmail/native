import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Selecting mail needed a long press; native #91 asks for a tap on the
// left side, as the webmail's avatar does. The unified inbox and the
// extra-compact density (no avatar) had no tap target (#91 follow-up).

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '../../screens', p), 'utf8');

describe('list row avatar (#91)', () => {
  it('toggles the row into the selection on a tap', () => {
    const src = read('EmailListScreen.tsx');
    const avatar = src.slice(src.indexOf('{density.showAvatar && ('), src.indexOf('{/* Content */}'));
    expect(avatar).toMatch(/<Pressable\s+onPress=\{handleLongPress\}/);
    expect(avatar).toMatch(/accessibilityRole="checkbox"/);
    expect(avatar).toMatch(/accessibilityState=\{\{ checked: selected \}\}/);
    expect(avatar).toMatch(/<SenderAvatar/);
  });

  it('gives an extra-compact row, which has no avatar, a left strip that selects it', () => {
    const src = read('EmailListScreen.tsx');
    const gutter = src.slice(src.indexOf('{!density.showAvatar && !selectionMode && ('), src.indexOf('{/* Content */}'));
    expect(gutter).toMatch(/<Pressable\s+onPress=\{handleLongPress\}\s+style=\{styles\.selectGutter\}/);
    expect(gutter).toMatch(/accessibilityRole="checkbox"/);
    expect(src).toMatch(/selectGutter: \{\r?\n\s*position: 'absolute',/);
  });

  it('selects a unified inbox row from its avatar, or its left strip in extra compact', () => {
    const src = read('UnifiedInboxScreen.tsx');
    const avatar = src.slice(src.indexOf('{density.showAvatar && <Pressable'), src.indexOf('<View style={styles.content}>'));
    expect(avatar).toMatch(/onPress=\{\(\) => toggleSelect\(item\)\}/);
    expect(avatar).toMatch(/accessibilityRole="checkbox"/);
    expect(avatar).toMatch(/accessibilityState=\{\{ checked: isSelected \}\}/);
    expect(avatar).toMatch(/<SenderAvatar/);
    const gutter = src.slice(src.indexOf('{!density.showAvatar && !selectionMode && ('), src.indexOf('{density.showAvatar && <Pressable'));
    expect(gutter).toMatch(/<Pressable\s+onPress=\{\(\) => toggleSelect\(item\)\}\s+style=\{styles\.selectGutter\}/);
  });
});
