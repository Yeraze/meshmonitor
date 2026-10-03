/**
 * Live Mesh Activity (#5557): values shared by the dashboard widget and
 * `GET /api/packets/stats/node-activity`, so the two cannot drift.
 */

/** Rolling windows the widget offers and the route accepts, in minutes. */
export const NODE_ACTIVITY_WINDOWS = [1, 5, 10, 30, 60] as const;

/** Window used when the widget is first added or the query omits one. */
export const NODE_ACTIVITY_DEFAULT_WINDOW = 10;
