/**
 * The scrolling body of a MeshCore list pane (`.meshcore-list-pane-body`),
 * virtualized once the list is long.
 *
 * A big MeshCore mesh puts hundreds to thousands of rows in the Nodes and
 * Node Details lists. Rendering every row costs DOM size, open time and
 * redraw time on each update, so past `threshold` rows only the rows in view
 * (plus `overscan`) are mounted, with @tanstack/react-virtual (already used by
 * NodesTab and the packet monitors). Short lists render plainly, unchanged.
 *
 * Rows vary a little in height (meta line wraps, optional neighbour tag), so
 * each mounted row is measured. Rows keep their own markup; this wraps each
 * one in a positioned div.
 */
import React, { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export interface MeshCoreVirtualListProps<T> {
  items: readonly T[];
  getKey: (item: T) => string;
  renderRow: (item: T) => React.ReactNode;
  /** Expected row height in px, before measurement. */
  estimateSize: number;
  /** Shown instead of rows when `items` is empty. */
  empty?: React.ReactNode;
  /** Lists up to this length render every row. */
  threshold?: number;
  overscan?: number;
}

export const MESHCORE_VIRTUAL_THRESHOLD = 100;

export function MeshCoreVirtualList<T>({
  items,
  getKey,
  renderRow,
  estimateSize,
  empty,
  threshold = MESHCORE_VIRTUAL_THRESHOLD,
  overscan = 8,
}: MeshCoreVirtualListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualize = items.length > threshold;
  const virtualizer = useVirtualizer({
    count: virtualize ? items.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    overscan,
    measureElement: (el) => el.getBoundingClientRect().height,
    getItemKey: (index) => (items[index] ? getKey(items[index]) : index),
  });

  let body: React.ReactNode;
  if (items.length === 0) {
    body = empty ?? null;
  } else if (!virtualize) {
    body = items.map(item => <React.Fragment key={getKey(item)}>{renderRow(item)}</React.Fragment>);
  } else {
    body = (
      <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
        {virtualizer.getVirtualItems().map(v => {
          const item = items[v.index];
          if (!item) return null;
          return (
            <div
              key={v.key}
              data-index={v.index}
              ref={virtualizer.measureElement}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${v.start}px)` }}
            >
              {renderRow(item)}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="meshcore-list-pane-body" ref={scrollRef}>
      {body}
    </div>
  );
}
