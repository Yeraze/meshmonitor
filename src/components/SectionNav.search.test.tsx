/**
 * @vitest-environment jsdom
 *
 * In-page section filter (#5182).
 *
 * The filter's whole value is that it matches a section's RENDERED text, not
 * just its heading — "battery" has to find the Power panel even though nothing
 * in the nav says "battery". These tests put real sections in the document and
 * assert on both halves of the behaviour: which chips survive, and which
 * sections the generated stylesheet hides.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, screen, act } from '@testing-library/react';
import SectionNav from './SectionNav';

const ITEMS = [
  { id: 'sec-power', label: 'Power' },
  { id: 'sec-map', label: 'Map', keywords: ['tiles'] },
  { id: 'sec-lora', label: 'LoRa' },
];

/** The real sections these chips point at, with text the filter can read. */
function mountSections() {
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<div id="sec-power">Shutdown on battery level</div>
     <div id="sec-map">Basemap chooser</div>
     <div id="sec-lora">Region and modem preset</div>`,
  );
}

/** Ids the component's generated stylesheet hides, in document order. */
function hiddenIds(): string[] {
  const style = document.querySelector('nav style');
  if (!style?.textContent) return [];
  return style.textContent
    .replace(/\{.*$/, '')
    .split(',')
    .map((selector) => selector.trim().replace(/^#/, ''))
    .filter(Boolean);
}

const type = (value: string) =>
  fireEvent.change(screen.getByRole('searchbox'), { target: { value } });

describe('SectionNav filter', () => {
  beforeEach(() => {
    mountSections();
    (window as unknown as { scrollTo: () => void }).scrollTo = vi.fn();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders no filter box unless asked for one', () => {
    render(<SectionNav items={ITEMS} />);
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('shows every chip and hides nothing while the query is empty', () => {
    render(<SectionNav items={ITEMS} searchable searchPlaceholder="Filter" />);
    expect(screen.getAllByRole('button')).toHaveLength(3);
    expect(hiddenIds()).toEqual([]);
  });

  it('matches a section by its own label', () => {
    render(<SectionNav items={ITEMS} searchable searchPlaceholder="Filter" />);
    type('lora');
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['LoRa']);
    expect(hiddenIds().sort()).toEqual(['sec-map', 'sec-power']);
  });

  it('matches a section by text rendered inside it, not just its heading', () => {
    render(<SectionNav items={ITEMS} searchable searchPlaceholder="Filter" />);
    type('battery');
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Power']);
    expect(hiddenIds().sort()).toEqual(['sec-lora', 'sec-map']);
  });

  it('matches a keyword that appears nowhere on screen', () => {
    render(<SectionNav items={ITEMS} searchable searchPlaceholder="Filter" />);
    type('tiles');
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Map']);
  });

  it('requires every token, so a multi-word query narrows rather than widens', () => {
    render(<SectionNav items={ITEMS} searchable searchPlaceholder="Filter" />);
    type('region preset');
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['LoRa']);
    type('region battery');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('says so when nothing matches, and hides every section', () => {
    render(
      <SectionNav items={ITEMS} searchable searchPlaceholder="Filter" noMatchesLabel="Nothing here" />,
    );
    type('zzzz');
    expect(screen.getByRole('status')).toHaveTextContent('Nothing here');
    expect(hiddenIds().sort()).toEqual(['sec-lora', 'sec-map', 'sec-power']);
  });

  it('restores everything when the query is cleared', () => {
    render(<SectionNav items={ITEMS} searchable searchPlaceholder="Filter" />);
    type('lora');
    expect(hiddenIds()).toHaveLength(2);
    type('');
    expect(hiddenIds()).toEqual([]);
    expect(screen.getAllByRole('button')).toHaveLength(3);
  });

  it('clears the query on Escape instead of letting it close a surrounding modal', () => {
    const onKeyDown = vi.fn();
    render(
      <div onKeyDown={onKeyDown}>
        <SectionNav items={ITEMS} searchable searchPlaceholder="Filter" />
      </div>,
    );
    type('lora');
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it('never names a section whose id would not be a safe selector', () => {
    document.body.insertAdjacentHTML('afterbegin', '<div id="bad id">unrelated</div>');
    render(
      <SectionNav
        items={[...ITEMS, { id: 'bad id', label: 'Odd' }]}
        searchable
        searchPlaceholder="Filter"
      />,
    );
    type('lora');
    expect(hiddenIds()).not.toContain('bad id');
  });
});

describe('SectionNav deep link', () => {
  beforeEach(() => {
    mountSections();
    (window as unknown as { scrollTo: () => void }).scrollTo = vi.fn();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    window.location.hash = '';
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('scrolls to the section named by the URL hash', () => {
    window.location.hash = '#sec-map';
    render(<SectionNav items={ITEMS} />);
    act(() => { vi.advanceTimersByTime(200); });
    expect(window.scrollTo).toHaveBeenCalled();
  });

  it('ignores a hash that names nothing in this nav', () => {
    window.location.hash = '#not-a-section';
    render(<SectionNav items={ITEMS} />);
    act(() => { vi.advanceTimersByTime(200); });
    expect(window.scrollTo).not.toHaveBeenCalled();
  });
});
