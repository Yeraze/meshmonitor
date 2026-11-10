/**
 * Sender-name validation for the MeshCore `senderName` override (#6282). The
 * logic lives in `src/utils/meshcoreSenderName.ts` so the client shares it;
 * this module keeps the server import path stable.
 */
export * from '../../utils/meshcoreSenderName.js';
