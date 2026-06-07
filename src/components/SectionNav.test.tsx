/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import SectionNav from './SectionNav';

/**
 * Regression for the standalone settings page where NO section-nav button
 * scrolled. `<body>` computes to overflow-y:auto but isn't the scroller (it's
 * as tall as its content — the window scrolls). SectionNav used to pick the
 * first overflow:auto ancestor (body) and call body.scrollBy(), a no-op.
 *
 * jsdom doesn't lay out, so we stub scrollHeight/clientHeight and the scroll
 * methods to assert which scroller SectionNav drives.
 */
describe('SectionNav scrollToSection', () => {
  let scrollToSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollToSpy = vi.fn();
    (window as any).scrollTo = scrollToSpy;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const sizeOf = (el: HTMLElement, scrollH: number, clientH: number) => {
    Object.defineProperty(el, 'scrollHeight', { value: scrollH, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: clientH, configurable: true });
  };

  it('scrolls the window when the only overflow ancestor is a non-scrollable body', () => {
    // Section sits directly under body; body is not actually scrollable.
    const section = document.createElement('div');
    section.id = 'sec-a';
    document.body.appendChild(section);
    sizeOf(document.body, 1000, 1000); // overflow auto in jsdom default? force not-scrollable

    const { getByRole } = render(<SectionNav items={[{ id: 'sec-a', label: 'A' }]} />);
    fireEvent.click(getByRole('button', { name: 'A' }));

    expect(scrollToSpy).toHaveBeenCalledTimes(1);
  });

  it('scrolls an inner pane when an ancestor is actually scrollable', () => {
    const pane = document.createElement('div');
    pane.style.overflowY = 'auto';
    sizeOf(pane, 2000, 500); // scrollHeight > clientHeight ⇒ a real scroller
    const scrollBySpy = vi.fn();
    (pane as any).scrollBy = scrollBySpy;
    pane.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;

    const section = document.createElement('div');
    section.id = 'sec-b';
    section.getBoundingClientRect = () => ({ top: 300 }) as DOMRect;
    pane.appendChild(section);
    document.body.appendChild(pane);

    const { getByRole } = render(<SectionNav items={[{ id: 'sec-b', label: 'B' }]} />);
    fireEvent.click(getByRole('button', { name: 'B' }));

    expect(scrollBySpy).toHaveBeenCalledTimes(1);
    expect(scrollToSpy).not.toHaveBeenCalled();
  });

  it('does nothing when the target section id is absent', () => {
    const { getByRole } = render(<SectionNav items={[{ id: 'missing', label: 'X' }]} />);
    fireEvent.click(getByRole('button', { name: 'X' }));
    expect(scrollToSpy).not.toHaveBeenCalled();
  });
});
