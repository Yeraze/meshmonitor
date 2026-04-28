/**
 * Tests for useAutoResizeTextarea
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { useAutoResizeTextarea } from './useAutoResizeTextarea';

function setup(initialValue: string, scrollHeight: number, lineHeightPx = 20) {
  const textarea = document.createElement('textarea');
  textarea.style.lineHeight = `${lineHeightPx}px`;
  textarea.style.padding = '0';
  textarea.style.border = '0';
  document.body.appendChild(textarea);

  Object.defineProperty(textarea, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  });

  return renderHook(
    ({ value }) => {
      const ref = useRef<HTMLTextAreaElement>(textarea);
      useAutoResizeTextarea(ref, value);
      return ref;
    },
    { initialProps: { value: initialValue } },
  );
}

describe('useAutoResizeTextarea', () => {
  it('grows textarea height to match content within max', () => {
    const { result } = setup('one\ntwo', 60, 20);
    const el = result.current.current!;
    expect(el.style.height).toBe('60px');
    expect(el.style.overflowY).toBe('hidden');
  });

  it('caps height at maxRows × lineHeight and switches to scroll', () => {
    // 6 rows × 20px = 120px ceiling, content wants 400px
    const { result } = setup('many lines', 400, 20);
    const el = result.current.current!;
    expect(el.style.height).toBe('120px');
    expect(el.style.overflowY).toBe('auto');
  });

  it('recomputes when value changes', () => {
    const textarea = document.createElement('textarea');
    textarea.style.lineHeight = '20px';
    document.body.appendChild(textarea);
    let scrollHeight = 30;
    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });

    const { result, rerender } = renderHook(
      ({ value }) => {
        const ref = useRef<HTMLTextAreaElement>(textarea);
        useAutoResizeTextarea(ref, value);
        return ref;
      },
      { initialProps: { value: 'short' } },
    );
    expect(result.current.current!.style.height).toBe('30px');

    scrollHeight = 80;
    rerender({ value: 'longer\ntext\nwith\nmore' });
    expect(result.current.current!.style.height).toBe('80px');
  });
});
