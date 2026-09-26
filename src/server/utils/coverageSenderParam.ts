/**
 * `sender` param parsing, shared by `coverageRoutes.ts` (query param) and
 * `coverageSurveyRoutes.ts` (`senderId` body field, #5277 P4b WP2).
 *
 * Extracted into its own module (rather than exported from
 * `coverageRoutes.ts`, where it originated in Phase 1 WP3) so
 * `coverageRoutes.ts` can mount `coverageSurveyRoutes.ts` at `/surveys`
 * without a circular ES-module import: `coverageRoutes.ts` importing
 * `coverageSurveyRoutes.ts` for the mount, and `coverageSurveyRoutes.ts`
 * importing `parseSenderParam` back from `coverageRoutes.ts`, left one of
 * the two default exports `undefined` at `router.use()` time — Express then
 * threw `argument handler must be a function` at import time.
 */
import { nodeNumToId, isMeshCorePubKeyId } from '../../utils/coverage.js';
import { parseGatewayNodeNum } from './okToMqtt.js';

/**
 * A `!xxxxxxxx` id, a decimal node number (normalised to `!xxxxxxxx`, the
 * form Meshtastic `coverage_receptions.senderId` rows store), or a 64-hex
 * MeshCore public key (lowercased, the form MeshCore rows store — #5277 P3
 * §2.5). Returns `null` on anything unparseable.
 */
export function parseSenderParam(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const trimmed = raw.trim();
  if (isMeshCorePubKeyId(trimmed)) return trimmed.toLowerCase();
  if (trimmed.startsWith('!')) {
    const nodeNum = parseGatewayNodeNum(trimmed);
    return nodeNum === null ? null : nodeNumToId(nodeNum);
  }
  if (!/^\d+$/.test(trimmed)) return null;
  const nodeNum = Number(trimmed);
  if (!Number.isFinite(nodeNum) || nodeNum > 0xffffffff) return null;
  return nodeNumToId(nodeNum >>> 0);
}
