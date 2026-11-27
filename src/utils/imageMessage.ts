import { parseSpip } from './spip.js';
import { isMcoImageCandidate } from './mcoImage/detect.js';

/** True when a message is drawn as an image (SPIP or MCOimg candidate); such messages are not translatable. */
export function isImageMessageText(text: string | null | undefined): boolean {
  return !!text && (parseSpip(text) != null || isMcoImageCandidate(text));
}
