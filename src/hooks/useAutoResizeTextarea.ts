import { useLayoutEffect, type RefObject } from 'react';

const DEFAULT_LINE_HEIGHT_PX = 20;

export function useAutoResizeTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  maxRows = 6,
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const computed = getComputedStyle(el);
    const lineHeight = parseFloat(computed.lineHeight) || DEFAULT_LINE_HEIGHT_PX;
    const paddingY =
      (parseFloat(computed.paddingTop) || 0) +
      (parseFloat(computed.paddingBottom) || 0);
    const borderY =
      (parseFloat(computed.borderTopWidth) || 0) +
      (parseFloat(computed.borderBottomWidth) || 0);
    const max = lineHeight * maxRows + paddingY + borderY;
    const next = Math.min(el.scrollHeight, max);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [ref, value, maxRows]);
}
