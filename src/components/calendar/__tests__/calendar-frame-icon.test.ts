// The today button writes the day number over its icon, so that icon must not
// draw anything of its own in the date cell.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('react-native-svg', () => ({ default: 'Svg', Path: 'Path' }));

function glyphOf(icon: unknown): string[] {
  const memo = icon as { type: (p: object) => { props: { children: { props: { d: string } }[] } } };
  return memo.type({}).props.children.map((child) => child.props.d);
}

describe('CalendarFrame', () => {
  it('is the Tabler calendar without the digit in its date cell', async () => {
    const { Calendar } = await import('../../icons');
    const { CalendarFrame } = await import('../calendar-frame-icon');
    const digit = ['M11 15h1', 'M12 15v3'];

    expect(glyphOf(Calendar)).toEqual(expect.arrayContaining(digit));
    expect(glyphOf(CalendarFrame)).toEqual(glyphOf(Calendar).filter((d) => !digit.includes(d)));
  });

  it('is what the today button draws under the day number', () => {
    const screen = readFileSync(join(__dirname, '..', '..', '..', 'screens', 'CalendarScreen.tsx'), 'utf8');
    const button = screen.slice(screen.indexOf("'Go to today'"), screen.indexOf('styles.todayIconText'));

    expect(button).toContain('<CalendarFrame ');
  });
});
