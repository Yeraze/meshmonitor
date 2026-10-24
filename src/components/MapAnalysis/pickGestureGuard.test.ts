/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { attachPickGestureGuard, PICK_MOVE_TOLERANCE_PX } from './pickGestureGuard';

function ev(type: string, x = 0, y = 0, pointerId = 1) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(e, 'pointerId', { value: pointerId });
  return e;
}

describe('attachPickGestureGuard (#5959)', () => {
  it('treats movement past the tolerance as a gesture', () => {
    const el = document.createElement('div');
    const guard = attachPickGestureGuard(el);
    el.dispatchEvent(ev('pointerdown', 0, 0));
    el.dispatchEvent(ev('pointermove', PICK_MOVE_TOLERANCE_PX + 1, 0));
    window.dispatchEvent(ev('pointerup'));
    expect(guard.isGesture(ev('click'))).toBe(true);
    // A fresh press resets it.
    el.dispatchEvent(ev('pointerdown', 50, 50));
    window.dispatchEvent(ev('pointerup'));
    expect(guard.isGesture(ev('click'))).toBe(false);
    guard.dispose();
  });

  it('ignores Space while typing in a field', () => {
    const el = document.createElement('div');
    const input = document.createElement('input');
    document.body.appendChild(input);
    const onNav = vi.fn();
    const guard = attachPickGestureGuard(el, onNav);
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
    expect(guard.isNavigating()).toBe(false);
    expect(onNav).not.toHaveBeenCalled();
    guard.dispose();
    input.remove();
  });

  it('drops Space-held state on window blur and stops listening once disposed', () => {
    const el = document.createElement('div');
    const onNav = vi.fn();
    const guard = attachPickGestureGuard(el, onNav);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' }));
    expect(guard.isNavigating()).toBe(true);
    window.dispatchEvent(new Event('blur'));
    expect(guard.isNavigating()).toBe(false);
    guard.dispose();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' }));
    expect(guard.isNavigating()).toBe(false);
    expect(onNav.mock.calls).toEqual([[true], [false]]);
  });
});
