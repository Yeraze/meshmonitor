import { useState, useCallback, useEffect, useRef } from 'react';

export interface UseResizableOptions {
  /** Unique ID for localStorage persistence */
  id: string;
  /** Default height in pixels */
  defaultHeight: number;
  /** Minimum height in pixels */
  minHeight?: number;
  /** Maximum height in pixels or percentage of viewport */
  maxHeight?: number;
  /** Direction of resize: 'vertical' resizes height, 'horizontal' resizes width */
  direction?: 'vertical' | 'horizontal';
}

export interface UseResizableReturn {
  size: number;
  isResizing: boolean;
  handleMouseDown: (e: React.MouseEvent) => void;
  handleTouchStart: (e: React.TouchEvent) => void;
  resetSize: () => void;
}

const STORAGE_PREFIX = 'resizable_size_';

function getStorageKey(id: string): string {
  return `${STORAGE_PREFIX}${id}`;
}

function loadSize(id: string, defaultSize: number): number {
  try {
    const saved = localStorage.getItem(getStorageKey(id));
    if (saved) {
      const parsed = parseFloat(saved);
      if (!isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }
  } catch {
    // Ignore parse errors
  }
  return defaultSize;
}

function saveSize(id: string, size: number): void {
  try {
    localStorage.setItem(getStorageKey(id), String(size));
  } catch {
    // Ignore storage errors
  }
}

export function useResizable(options: UseResizableOptions): UseResizableReturn {
  const {
    id,
    defaultHeight,
    minHeight = 100,
    maxHeight = window.innerHeight * 0.8,
    direction = 'vertical'
  } = options;

  const [size, setSize] = useState<number>(() => loadSize(id, defaultHeight));
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef<{ startPos: number; startSize: number } | null>(null);

  // Constrain size to bounds
  const constrainSize = useCallback((newSize: number): number => {
    const effectiveMaxHeight = typeof maxHeight === 'number'
      ? Math.min(maxHeight, window.innerHeight * 0.8)
      : window.innerHeight * 0.8;
    return Math.max(minHeight, Math.min(newSize, effectiveMaxHeight));
  }, [minHeight, maxHeight]);

  // Handle mouse move during resize
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!resizeStartRef.current) return;

    // For vertical resize from top edge (panel at bottom), moving up increases size
    const delta = direction === 'vertical'
      ? resizeStartRef.current.startPos - e.clientY
      : e.clientX - resizeStartRef.current.startPos;

    const newSize = constrainSize(resizeStartRef.current.startSize + delta);
    setSize(newSize);
  }, [constrainSize, direction]);

  // Handle touch move during resize
  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!resizeStartRef.current || !e.touches[0]) return;

    const delta = direction === 'vertical'
      ? resizeStartRef.current.startPos - e.touches[0].clientY
      : e.touches[0].clientX - resizeStartRef.current.startPos;

    const newSize = constrainSize(resizeStartRef.current.startSize + delta);
    setSize(newSize);
  }, [constrainSize, direction]);

  // Handle resize end
  const handleResizeEnd = useCallback(() => {
    if (resizeStartRef.current) {
      resizeStartRef.current = null;
      setIsResizing(false);
      // Save size when resize ends
      setSize(currentSize => {
        saveSize(id, currentSize);
        return currentSize;
      });
    }
  }, [id]);

  // Set up global event listeners when resizing
  useEffect(() => {
    if (isResizing) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleResizeEnd);
      window.addEventListener('touchmove', handleTouchMove, { passive: false });
      window.addEventListener('touchend', handleResizeEnd);

      // Prevent text selection during resize
      document.body.style.userSelect = 'none';
      document.body.style.cursor = direction === 'vertical' ? 'ns-resize' : 'ew-resize';

      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleResizeEnd);
        window.removeEventListener('touchmove', handleTouchMove);
        window.removeEventListener('touchend', handleResizeEnd);
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
      };
    }
  }, [isResizing, handleMouseMove, handleTouchMove, handleResizeEnd, direction]);

  // Handle mouse down on resize handle
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    resizeStartRef.current = {
      startPos: direction === 'vertical' ? e.clientY : e.clientX,
      startSize: size
    };

    setIsResizing(true);
  }, [size, direction]);

  // Handle touch start on resize handle
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (!e.touches[0]) return;

    e.stopPropagation();

    resizeStartRef.current = {
      startPos: direction === 'vertical' ? e.touches[0].clientY : e.touches[0].clientX,
      startSize: size
    };

    setIsResizing(true);
  }, [size, direction]);

  // Reset to default size
  const resetSize = useCallback(() => {
    setSize(defaultHeight);
    saveSize(id, defaultHeight);
  }, [id, defaultHeight]);

  // Ensure size is valid on window resize
  useEffect(() => {
    const handleResize = () => {
      setSize(currentSize => constrainSize(currentSize));
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [constrainSize]);

  return {
    size,
    isResizing,
    handleMouseDown,
    handleTouchStart,
    resetSize
  };
}
