import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Selecting mail needed a long press; native #91 asks for a tap on the
// left side, as the webmail's avatar does.

describe('list row avatar (#91)', () => {
  it('toggles the row into the selection on a tap', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../screens/EmailListScreen.tsx'), 'utf8');
    const avatar = src.slice(src.indexOf('{density.showAvatar && ('), src.indexOf('{/* Content */}'));
    expect(avatar).toMatch(/<Pressable\s+onPress=\{handleLongPress\}/);
    expect(avatar).toMatch(/accessibilityRole="checkbox"/);
    expect(avatar).toMatch(/accessibilityState=\{\{ checked: selected \}\}/);
    expect(avatar).toMatch(/<SenderAvatar/);
  });
});
