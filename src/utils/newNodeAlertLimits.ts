/**
 * New-node alert limits (#6306), shared by the server gate
 * (`server/services/newNodeAlertGate.ts`) and the Notifications tab note, so the
 * text a user reads always matches what the server enforces. Constants, not
 * settings: the maintainer picks the numbers.
 */
/** Learning window in hours: 4 default 12 h flood-advert cycles. */
export const NEW_NODE_LEARN_HOURS = 48;
/** Most alerts per source per fixed hour once the window has ended. */
export const NEW_NODE_CAP_PER_HOUR = 10;
