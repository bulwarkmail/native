import { describe, expect, it, vi } from 'vitest';

// The package entry pulls in the native module, so hand the layouts the plain
// widget components and run them through the library's own tree builder: it
// is what throws on the device when a layout returns null, puts null in a
// mapped list or uses a Fragment. Colours are checked on the way in, because
// the library quietly turns any it cannot parse (a name, `transparent`) into
// white.
vi.mock('react-native-android-widget', async () => {
  const COLOR = /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba\(.*\))$/i;
  const checkColors = (widget: string, style: Record<string, unknown> = {}) => {
    for (const [key, value] of Object.entries(style)) {
      if (/colou?r$/i.test(key) && !(typeof value === 'string' && COLOR.test(value))) {
        throw new Error(`${widget} ${key}: ${JSON.stringify(value)} is not a colour the widget renderer reads`);
      }
    }
  };
  type Widget = { __name__: string; convertProps: (props: { style?: Record<string, unknown> }) => unknown };
  const checked = (module: Record<string, unknown>) => {
    for (const value of Object.values(module)) {
      if (typeof value !== 'function' || !('__name__' in value)) continue;
      const widget = value as unknown as Widget;
      const convert = widget.convertProps;
      widget.convertProps = (props) => {
        checkColors(widget.__name__, props.style);
        return convert(props);
      };
    }
    return module;
  };
  // The compiled SvgWidget requires react-native (past the stub) to resolve
  // bundled images; the widgets only draw inline SVG strings, so rebuild it
  // from the library's own style and click converters.
  const { convertCommonStyle } = await import('react-native-android-widget/lib/commonjs/widgets/utils/style.utils' as string);
  const { convertClickAction } = await import('react-native-android-widget/lib/commonjs/widgets/utils/click-action' as string);
  function SvgWidget() {
    return null;
  }
  SvgWidget.__name__ = 'SvgWidget';
  SvgWidget.convertProps = (props: { style?: object; svg: unknown }) => {
    if (typeof props.svg !== 'string') throw new Error('widgets draw inline SVG strings only');
    return { ...convertCommonStyle(props.style ?? {}), ...convertClickAction(props), svgString: props.svg };
  };
  return {
    ...checked(await import('react-native-android-widget/lib/commonjs/widgets/FlexWidget' as string)),
    ...checked(await import('react-native-android-widget/lib/commonjs/widgets/ListWidget' as string)),
    ...checked(await import('react-native-android-widget/lib/commonjs/widgets/OverlapWidget' as string)),
    ...checked(await import('react-native-android-widget/lib/commonjs/widgets/TextWidget' as string)),
    ...checked({ SvgWidget }),
    getWidgetInfo: vi.fn(async () => []),
    requestWidgetUpdate: vi.fn(async () => undefined),
  };
});

import { createElement } from 'react';
import { FlexWidget } from 'react-native-android-widget';
import catalog from '../catalog.json';
import { renderFor } from '../render';
import { PREVIEW_NOW, sampleSnapshot } from '../sample-snapshot';
import { emptySnapshot, type WidgetSnapshot } from '../snapshot';

const { buildWidgetTree } = (await import(
  'react-native-android-widget/lib/commonjs/api/build-widget-tree' as string
)) as { buildWidgetTree: (tree: unknown) => { type: string } };

// Launcher cells to dp, roughly what a phone launcher reports.
const dp = (cells: number) => cells * 90 - 15;

function build(name: string, s: WidgetSnapshot, cols: number, rows: number, local = {}) {
  const trees = renderFor(name, s, { width: dp(cols), height: dp(rows), widgetId: 1 }, local, PREVIEW_NOW);
  for (const tree of 'light' in trees ? [trees.light, trees.dark] : [trees]) {
    expect(buildWidgetTree(tree).type).toBeTruthy();
  }
}

const sizes = (w: (typeof catalog.widgets)[number]) => [
  [w.minCols, w.minRows],
  [w.cols, w.rows],
  [4, 4],
  [5, 5],
];

describe('widget layouts', () => {
  it('uses a builder that rejects what the device rejects', () => {
    const Nothing = () => null;
    expect(() => buildWidgetTree(createElement(Nothing))).toThrow();
    expect(() => buildWidgetTree(createElement(FlexWidget, null, createElement(FlexWidget), [null]))).toThrow();
    expect(() => buildWidgetTree(createElement(FlexWidget, { style: { backgroundColor: 'teal' } } as never))).toThrow();
  });

  const sample = { ...sampleSnapshot(PREVIEW_NOW), theme: 'system' as const };
  const empty: WidgetSnapshot = {
    ...emptySnapshot(),
    generatedAt: PREVIEW_NOW,
    appDataAt: PREVIEW_NOW,
    signedIn: true,
    theme: 'system',
    accounts: [{ id: 'a', label: 'Work', color: '#2563eb', unread: 0 }],
    activeAccountId: 'a',
    calendar: { supported: true, events: [], invitations: [], birthdays: [] },
    tasks: { supported: true, items: [] },
    files: { supported: true, items: [] },
  };

  it.each(catalog.widgets.map((w) => [w.name, w] as const))('%s builds with demo data at every size', (name, w) => {
    for (const [cols, rows] of sizes(w)) build(name, sample, cols, rows);
  });

  it.each(catalog.widgets.map((w) => [w.name, w] as const))('%s builds with nothing to show', (name, w) => {
    for (const [cols, rows] of sizes(w)) build(name, empty, cols, rows);
  });

  it('builds the signed-out, loading and not-loaded-yet states', () => {
    for (const w of catalog.widgets) {
      build(w.name, { ...emptySnapshot(), generatedAt: PREVIEW_NOW }, w.cols, w.rows);
      build(w.name, emptySnapshot(), w.cols, w.rows);
      build(w.name, { ...sample, appDataAt: 0 }, w.cols, w.rows);
    }
  });

  it('builds the triage card on a message that is gone', () => {
    build('TriageWidget', sample, 4, 2, { triageId: 'no-such-message' });
    build('TriageWidget', { ...sample, mail: { ...sample.mail, inbox: [] } }, 4, 2, { triageId: 'm1' });
  });
});
