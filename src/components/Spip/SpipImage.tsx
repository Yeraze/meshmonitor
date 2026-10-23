import React from 'react';
import type { SpipImage as SpipImageData } from '../../utils/spip.js';
import styles from './SpipImage.module.css';

interface SpipImageProps {
  image: SpipImageData;
  /** The raw SPIP code, kept as the tooltip and accessible label. */
  code: string;
}

/**
 * Draws a decoded SPIP1 image (see `src/utils/spip.ts`). The SVG keeps one
 * unit per pixel and scales up with crisp edges, so a 3x3 and a 12x12 image
 * render at the same size in the bubble.
 */
export const SpipImage: React.FC<SpipImageProps> = ({ image, code }) => (
  <svg
    className={styles.image}
    viewBox={`0 0 ${image.cols} ${image.rows}`}
    shapeRendering="crispEdges"
    role="img"
    aria-label={`SPIP image ${image.cols}x${image.rows}: ${code}`}
    data-testid="spip-image"
  >
    <title>{code}</title>
    {image.pixels.map((fill, i) => (
      <rect key={i} x={i % image.cols} y={Math.floor(i / image.cols)} width={1} height={1} fill={fill} />
    ))}
  </svg>
);

export default SpipImage;
