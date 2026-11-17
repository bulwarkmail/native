import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', '..', rel), 'utf8');

describe('swipe follows the finger on the UI thread', () => {
  it('drives the row from a native pan gesture, not the JS responder', () => {
    const row = read('src/components/SwipeableRow.tsx');
    expect(row).toMatch(/<GestureDetector gesture=\{pan\}>/);
    expect(row).toMatch(/useAnimatedStyle/);
    expect(row).not.toMatch(/PanResponder/);
  });

  it('computes the drag offset inside the gesture worklet', () => {
    const logic = read('src/components/swipe-gesture.ts');
    for (const fn of ['dragOffset', 'restingOffset', 'releaseWouldAct']) {
      expect(logic).toMatch(new RegExp(`export function ${fn}\\([^)]*\\)[^{]*\\{\\s+'worklet';`));
    }
  });

  it('gives the app a gesture root', () => {
    expect(read('index.ts')).toMatch(/GestureHandlerRootView/);
  });

  it('ticks when the swipe arms its action', () => {
    expect(read('src/components/SwipeableRow.tsx')).toMatch(/runOnJS\(haptic\)\('selection'\)/);
  });
});

describe('swipe keeps its momentum on release', () => {
  it('decides the release and starts its animation on the UI thread, at the finger’s release velocity', () => {
    const row = read('src/components/SwipeableRow.tsx');
    const onEnd = row.slice(row.indexOf('.onEnd('), row.indexOf('.onFinalize('));
    expect(onEnd).toMatch(/const outcome = resolveRelease\(\{ dx: tx\.value - restingOffset\(side\), dy: e\.translationY, vx \}, config, side\)/);
    expect(onEnd).toMatch(/const plan = flyPlan\(toValue - tx\.value, vx\);/);
    expect(onEnd).toMatch(/tx\.value = withTiming\(toValue,/);
    expect(onEnd).toMatch(/springBack\(0, vx\)/);
    expect(onEnd).not.toMatch(/runOnJS\(finish\)/);
    expect(row).toMatch(/tx\.value = withSpring\(toValue, \{ \.\.\.SETTLE_SPRING, velocity: velocity \* 1000 \}/);
  });
});

describe('rows leave and come back animated, like the web list', () => {
  it('fades a departing row out and fades a returning row in', () => {
    const row = read('src/components/SwipeableRow.tsx');
    expect(row).toMatch(/exiting=\{leaving \? ROW_EXIT : undefined\}/);
    expect(row).toMatch(/entering=\{appearing \? ROW_ENTER : undefined\}/);
    expect(row).toMatch(/const ROW_EXIT = FadeOut\.duration\(150\)/);
  });

  it('keeps a flown-off row off screen instead of flashing it back while the server works', () => {
    const row = read('src/components/SwipeableRow.tsx');
    const afterFly = row.slice(row.indexOf('const afterFly'), row.indexOf('const fly ='));
    expect(afterFly).not.toMatch(/tx\.value = 0/);
    expect(afterFly).toMatch(/setTimeout\(comeBack, COME_BACK_MS\)/);
  });

  it('slides the other rows into place with the web list’s easing', () => {
    const list = read('src/components/SwipeLockedFlatList.tsx');
    expect(list).toMatch(/LinearTransition\.duration\(300\)\.easing\(Easing\.bezier\(0\.3, 0\.5, 0\.2, 1\)\)/);
    expect(list).toMatch(/CellRendererComponent=\{props\.CellRendererComponent \?\? ShiftingCell\}/);
  });

  it('hides a row as soon as its archive, delete or spam starts and shows it again if that fails', () => {
    const screen = read('src/screens/EmailListScreen.tsx');
    expect(screen).toMatch(/departures\.visible\(collapseThreads\(emails, disableThreading\), rowKeyOf\)/);
    expect(screen).toMatch(/reportFailure\(leave\(confirmMailRemoval\('archive'/);
    expect(screen).toMatch(/reportFailure\(leave\(deleteIds\(idsForRow\(id\)\)\)\)/);
    expect(screen).toMatch(/reportFailure\(leave\(markSpam\(idsForRow\(id\)\)\)\)/);
    expect(screen).toMatch(/appearing=\{/);
  });

  it('taps when an action fires and when undo is pressed', () => {
    expect(read('src/components/SwipeableRow.tsx')).toMatch(/const tick = releaseHaptic\(outcome, armed\.value\);\s+if \(tick\) runOnJS\(haptic\)\(tick\);/);
    expect(read('src/components/UndoSnackbar.tsx')).toMatch(/haptic\('light'\);\s+void undoLast\(\);/);
  });
});
