import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useDraggable, type Position } from '../hooks/useDraggable';
import './DraggableOverlay.css';

interface DraggableOverlayProps {
  /** Unique ID for position persistence */
  id: string;
  /** Default position (from top-left corner) */
  defaultPosition: Position;
  /** Child content */
  children: React.ReactNode;
  /** Additional class name */
  className?: string;
  /** Z-index for the overlay */
  zIndex?: number;
}

export const DraggableOverlay: React.FC<DraggableOverlayProps> = ({
  id,
  defaultPosition,
  children,
  className = '',
  zIndex = 1000
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragHandleRef = useRef<HTMLDivElement>(null);
  const [elementSize, setElementSize] = useState({ width: 200, height: 100 });

  // Measure element size after mount
  useEffect(() => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setElementSize({ width: rect.width, height: rect.height });
    }
  }, []);

  const { position, isDragging, handleMouseDown, handleTouchStart } = useDraggable({
    id,
    defaultPosition,
    constrainToViewport: true,
    elementSize
  });

  // Wrap React handlers to use with native events
  const nativeMouseDownHandler = useCallback((e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Create a synthetic-like event object for the React handler
    handleMouseDown({
      clientX: e.clientX,
      clientY: e.clientY,
      preventDefault: () => e.preventDefault(),
      stopPropagation: () => e.stopPropagation()
    } as React.MouseEvent);
  }, [handleMouseDown]);

  const nativeTouchStartHandler = useCallback((e: TouchEvent) => {
    e.stopPropagation();
    if (e.touches[0]) {
      handleTouchStart({
        touches: e.touches,
        stopPropagation: () => e.stopPropagation()
      } as unknown as React.TouchEvent);
    }
  }, [handleTouchStart]);

  // Attach native event listeners to drag handle to intercept before Leaflet
  useEffect(() => {
    const handle = dragHandleRef.current;
    if (!handle) return;

    // Use capture phase to intercept events before they reach Leaflet
    handle.addEventListener('mousedown', nativeMouseDownHandler, { capture: true });
    handle.addEventListener('touchstart', nativeTouchStartHandler, { capture: true });

    return () => {
      handle.removeEventListener('mousedown', nativeMouseDownHandler, { capture: true });
      handle.removeEventListener('touchstart', nativeTouchStartHandler, { capture: true });
    };
  }, [nativeMouseDownHandler, nativeTouchStartHandler]);

  // Prevent map zoom on wheel/dblclick over the entire overlay
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const stopEvent = (e: Event) => {
      e.stopPropagation();
    };

    el.addEventListener('wheel', stopEvent, { capture: true });
    el.addEventListener('dblclick', stopEvent, { capture: true });

    return () => {
      el.removeEventListener('wheel', stopEvent, { capture: true });
      el.removeEventListener('dblclick', stopEvent, { capture: true });
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={`draggable-overlay ${className} ${isDragging ? 'dragging' : ''}`}
      style={{
        position: 'fixed',
        left: position.x,
        top: position.y,
        zIndex: isDragging ? zIndex + 100 : zIndex,
        cursor: isDragging ? 'grabbing' : undefined
      }}
    >
      <div
        ref={dragHandleRef}
        className="drag-handle"
        title="Drag to move"
      >
        <span className="drag-handle-icon">
          <span></span>
          <span></span>
          <span></span>
        </span>
      </div>
      <div className="draggable-content">
        {children}
      </div>
    </div>
  );
};

export default DraggableOverlay;
