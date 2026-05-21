/**
 * @vitest-environment jsdom
 */
import type { FocusEvent } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scrollInputIntoView } from './scrollInputIntoView';

describe('scrollInputIntoView', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('calls scrollIntoView on the focused element after a delay (iOS path)', () => {
    (window as any).visualViewport = { height: 500 };

    const input = document.createElement('textarea');
    document.body.appendChild(input);
    input.focus();
    input.scrollIntoView = () => {}; // jsdom doesn't define this method
    const scrollSpy = vi.spyOn(input, 'scrollIntoView');

    scrollInputIntoView({
      currentTarget: input,
    } as unknown as FocusEvent<HTMLTextAreaElement>);

    expect(scrollSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
  });

  it('is a no-op on browsers without visualViewport (desktop)', () => {
    (window as any).visualViewport = undefined;

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.scrollIntoView = () => {}; // jsdom doesn't define this method
    const scrollSpy = vi.spyOn(input, 'scrollIntoView');

    scrollInputIntoView({
      currentTarget: input,
    } as unknown as FocusEvent<HTMLInputElement>);

    vi.advanceTimersByTime(1000);
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('does not scroll if the input lost focus before the timeout fires', () => {
    (window as any).visualViewport = { height: 500 };

    const input = document.createElement('textarea');
    const other = document.createElement('input');
    document.body.appendChild(input);
    document.body.appendChild(other);
    input.focus();
    input.scrollIntoView = () => {}; // jsdom doesn't define this method
    const scrollSpy = vi.spyOn(input, 'scrollIntoView');

    scrollInputIntoView({
      currentTarget: input,
    } as unknown as FocusEvent<HTMLTextAreaElement>);

    other.focus(); // user moved focus before the timeout fires
    vi.advanceTimersByTime(300);

    expect(scrollSpy).not.toHaveBeenCalled();
  });
});
