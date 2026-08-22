/**
 * Subject-node substitution tokens shared by the help drawer and the token
 * typo-checker. Kept out of SubstitutionsHelp.tsx so that component file exports
 * only a component (react-refresh/only-export-components).
 */

/**
 * Hydrated subject-node tokens (`{{ node.longName }}`, …). Available on every
 * trigger that has a subject node — same paths conditions use in fieldselect.
 * Not under `trigger.*`: they hydrate from the DB node row at evaluation time.
 */
export const NODE_TOKENS: Array<[string, string]> = [
  ['longName', 'Node long name'],
  ['shortName', 'Node short name'],
  ['nodeId', 'Node id (!hex)'],
  ['roleName', 'Role name (e.g. ROUTER)'],
  ['batteryLevel', 'Battery level (%)'],
  ['voltage', 'Voltage'],
  ['hopsAway', 'Hops away'],
  ['latitude', 'Latitude'],
  ['longitude', 'Longitude'],
  ['altitude', 'Altitude'],
  ['mobile', 'Mobile flag (1 = mobile, 0 = stationary)'],
  ['ageMinutes', 'Minutes since last heard'],
  ['completeness', 'Node info completeness (complete / incomplete / unknown)'],
];

/** Triggers whose event carries a subject node (so `{{ node.* }}` can hydrate). */
export const SUBJECT_NODE_TRIGGER_TYPES = [
  'trigger.message',
  'trigger.nodeDiscovered',
  'trigger.nodeUpdated',
  'trigger.telemetry',
  'trigger.geofence',
  'trigger.becameMobile',
  'trigger.leftHome',
  'trigger.meshBeacon',
  'trigger.nodeStale',
  'trigger.nodeOnline',
  'trigger.nodeRebooted',
  'trigger.nodePowerChanged',
  'trigger.batteryTrend',
] as const;
