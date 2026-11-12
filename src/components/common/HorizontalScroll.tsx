/**
 * A sideways scroll box that fades whichever edge still hides content
 * (#4173 review N3). Wrap a table that may be wider than a phone in this
 * instead of a bare `overflow-x: auto` div, so the reader can tell more
 * columns sit off-screen.
 */
import React, { useRef } from 'react';
import { useHorizontalScrollEdges } from '../../hooks/useHorizontalScrollEdges';
import styles from './HorizontalScroll.module.css';

interface HorizontalScrollProps {
  /** Extra classes, e.g. the caller's sizing (flex, height). */
  className?: string;
  children: React.ReactNode;
}

const HorizontalScroll: React.FC<HorizontalScrollProps> = ({ className, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  const edges = useHorizontalScrollEdges(ref);
  return (
    <div
      ref={ref}
      className={className ? `${styles.scroll} ${className}` : styles.scroll}
      data-overflow-start={edges.start ? 'true' : 'false'}
      data-overflow-end={edges.end ? 'true' : 'false'}
    >
      {children}
    </div>
  );
};

export default HorizontalScroll;
