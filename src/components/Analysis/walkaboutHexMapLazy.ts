import { lazyWithPreload } from '../../utils/lazyWithPreload.js';

/** The only way any file reaches the hex map (keeps `h3-js` out of other chunks). */
export const WalkaboutHexMapLazy = lazyWithPreload(() => import('./WalkaboutHexMap'));
