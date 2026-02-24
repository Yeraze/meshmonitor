import { useState, useCallback, useEffect, useRef } from 'react';

export interface Position {
  x: number;
  y: number;
}

export interface UseDraggableOptions {
  /** Unique ID for localStorage persistence */
  id: string;
  /** Default position if none saved */
  defaultPosition: Position;
  /** Constrain to parent bounds */
  constrainToViewport?: boolean;
  /** Element dimensions for constraint calculation */
  elementSize?: { width: number; height: number };
}

export interface UseDraggableReturn {
  position: Position;
  isDragging: boolean;
  handleMouseDown: (e: React.MouseEvent) => void;
  handleTouchStart: (e: React.TouchEvent) => void;
  resetPosition: () => void;
}

const STORAGE_PREFIX = 'draggable_position_';

function getStorageKey(id: string): string {
  return `${STORAGE_PREFIX}${id}`;
}

function loadPosition(id: string, defaultPosition: Position): Position {
  try {
    const saved = localStorage.getItem(getStorageKey(id));
    if (saved) {
      const parsed = JSON.parse(saved);
      if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
        return parsed;
      }
    }
  } catch {
    // Ignore parse errors
  }
  return defaultPosition;
}

function savePosition(id: string, position: Position): void {
  try {
    localStorage.setItem(getStorageKey(id), JSON.stringify(position));
  } catch {
    // Ignore storage errors
  }
}

export function useDraggable(options: UseDraggableOptions): UseDraggableReturn {
  const { id, defaultPosition, constrainToViewport = true, elementSize } = options;

  const [position, setPosition] = useState<Position>(() => loadPosition(id, defaultPosition));
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number; posX: number; posY: number } | null>(null);

  // Constrain position to viewport bounds
  const constrainPosition = useCallback((pos: Position): Position => {
    if (!constrainToViewport) return pos;

    const width = elementSize?.width || 100;
    const height = elementSize?.height || 100;
    const padding = 5; // Small padding to keep element slightly visible

    return {
      x: Math.max(padding, Math.min(pos.x, window.innerWidth - width - padding)),
      y: Math.max(padding, Math.min(pos.y, window.innerHeight - height - padding))
    };
  }, [constrainToViewport, elementSize]);

  // Handle mouse move during drag
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!dragStartRef.current) return;

    const deltaX = e.clientX - dragStartRef.current.x;
    const deltaY = e.clientY - dragStartRef.current.y;

    const newPos = constrainPosition({
      x: dragStartRef.current.posX + deltaX,
      y: dragStartRef.current.posY + deltaY
    });

    setPosition(newPos);
  }, [constrainPosition]);

  // Handle touch move during drag
  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!dragStartRef.current || !e.touches[0]) return;

    const deltaX = e.touches[0].clientX - dragStartRef.current.x;
    const deltaY = e.touches[0].clientY - dragStartRef.current.y;

    const newPos = constrainPosition({
      x: dragStartRef.current.posX + deltaX,
      y: dragStartRef.current.posY + deltaY
    });

    setPosition(newPos);
  }, [constrainPosition]);

  // Handle drag end
  const handleDragEnd = useCallback(() => {
    if (dragStartRef.current) {
      dragStartRef.current = null;
      setIsDragging(false);
      // Save position when drag ends
      setPosition(pos => {
        savePosition(id, pos);
        return pos;
      });
    }
  }, [id]);

  // Set up global event listeners when dragging
  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleDragEnd);
      window.addEventListener('touchmove', handleTouchMove, { passive: false });
      window.addEventListener('touchend', handleDragEnd);

      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleDragEnd);
        window.removeEventListener('touchmove', handleTouchMove);
        window.removeEventListener('touchend', handleDragEnd);
      };
    }
  }, [isDragging, handleMouseMove, handleTouchMove, handleDragEnd]);

  // Handle mouse down on drag handle
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      posX: position.x,
      posY: position.y
    };

    setIsDragging(true);
  }, [position]);

  // Handle touch start on drag handle
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (!e.touches[0]) return;

    e.stopPropagation();

    dragStartRef.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
      posX: position.x,
      posY: position.y
    };

    setIsDragging(true);
  }, [position]);

  // Reset to default position
  const resetPosition = useCallback(() => {
    setPosition(defaultPosition);
    savePosition(id, defaultPosition);
  }, [id, defaultPosition]);

  // Ensure position is valid on window resize (not on initial mount - let default position be used)
  useEffect(() => {
    const handleResize = () => {
      setPosition(pos => constrainPosition(pos));
    };

    window.addEventListener('resize', handleResize);
    // Don't run on mount - the default position is already appropriate

    return () => window.removeEventListener('resize', handleResize);
  }, [constrainPosition]);

  return {
    position,
    isDragging,
    handleMouseDown,
    handleTouchStart,
    resetPosition
  };
}
