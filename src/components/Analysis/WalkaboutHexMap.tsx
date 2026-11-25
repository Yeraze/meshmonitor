/**
 * Walkabout hex map (#5891 P2, spec §2.10). Skeleton; WP2 fills the body.
 * The only client file that may import `h3-js`; reached only through
 * `walkaboutHexMapLazy.ts`.
 */
import type { WalkaboutMapQuery } from '../../types/walkabout.js';

export interface WalkaboutHexMapProps {
  sourceId: string;
  query: WalkaboutMapQuery;
  /** Changes when source or window/session changes. Never includes res. */
  fitKey: string;
}

export default function WalkaboutHexMap(_props: WalkaboutHexMapProps): null {
  return null;
}
