/**
 * @vitest-environment jsdom
 *
 * MeshCoreVirtualList (perf P3-2): a long MeshCore list mounts only the rows
 * in view, a short one renders every row as before.
 */
import React from 'react';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MeshCoreVirtualList, MESHCORE_VIRTUAL_THRESHOLD } from './MeshCoreVirtualList';

// jsdom lays nothing out: give every element a 400px-high viewport and every
// measured row a 50px box, so the virtualizer sees real sizes.
const originalClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');
const originalClientWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
const originalRect = Element.prototype.getBoundingClientRect;
beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => 300 });
  Element.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 50, width: 300, height: 50, toJSON: () => ({}) }) as DOMRect;
});
afterAll(() => {
  if (originalClientHeight) Object.defineProperty(Element.prototype, 'clientHeight', originalClientHeight);
  if (originalClientWidth) Object.defineProperty(Element.prototype, 'clientWidth', originalClientWidth);
  Element.prototype.getBoundingClientRect = originalRect;
});

const keys = (n: number) => Array.from({ length: n }, (_, i) => `key-${i}`);

function List({ items }: { items: string[] }) {
  return (
    <MeshCoreVirtualList
      items={items}
      getKey={k => k}
      estimateSize={50}
      empty={<div>nothing here</div>}
      renderRow={k => <button className="mc-node-row">{k}</button>}
    />
  );
}

describe('MeshCoreVirtualList', () => {
  it('renders every row of a short list, inside the scrolling pane body', () => {
    const { container } = render(<List items={keys(MESHCORE_VIRTUAL_THRESHOLD)} />);
    const body = container.querySelector('.meshcore-list-pane-body');
    expect(body).not.toBeNull();
    expect(body!.querySelectorAll('.mc-node-row')).toHaveLength(MESHCORE_VIRTUAL_THRESHOLD);
  });

  it('mounts only a window of a long list', () => {
    const { container } = render(<List items={keys(2000)} />);
    const rows = container.querySelectorAll('.mc-node-row');
    // 400px / 50px = 8 in view, plus overscan on the far side.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(40);
    expect(rows[0].textContent).toBe('key-0');
    // The spacer holds the full height, so the scrollbar covers every row.
    const spacer = container.querySelector('.meshcore-list-pane-body > div') as HTMLElement;
    expect(spacer.style.height).toBe(`${2000 * 50}px`);
  });

  it('shows the empty state when there are no rows', () => {
    render(<List items={[]} />);
    expect(screen.getByText('nothing here')).toBeTruthy();
  });
});
