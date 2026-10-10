/**
 * Pins the set of server-side Meshtastic send call sites outside the HTTP
 * routes (#5414).
 *
 * A send made by MeshMonitor on its own (a scheduler, an automation, a
 * reactive reply) must be tagged `origin: 'automation'` so an MQTT bridge with
 * `dropAutomationUplinks` can keep it off the upstream broker. An untagged send
 * counts as manual, so a new automation that forgets the tag leaks upstream
 * silently. This test turns that into a loud failure: when a count below
 * changes, look at the new call and decide.
 *
 *  - Automation (scheduler/trigger/auto-reply)? Pass `{ origin: 'automation' }`
 *    (or use `sendAutomationText` / `enqueueAutomation` inside
 *    MeshtasticManager), then update the count.
 *  - User-initiated (a route, a button)? Leave it untagged and update the count.
 *
 * Route handlers (`src/server/routes/**`) are manual by definition and are not
 * scanned.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SERVER_DIR = join(__dirname);
const REPO_ROOT = join(__dirname, '..', '..');

// Meshtastic send entry points that put a packet on the air.
const SEND_CALL = new RegExp(
  '\\.(' +
    [
      'sendTextMessage',
      'sendAutomationText',
      'enqueue',
      'enqueueAutomation',
      'sendTraceroute',
      'sendPositionRequest',
      'sendNodeInfoRequest',
      'sendNeighborInfoRequest',
      'sendTelemetryRequest',
      'broadcastNodeInfoToChannel',
      'broadcastNodeInfoToChannels',
      'requestRemoteLocalStats',
      'broadcastWaypoint',
      'sendAutoAnnouncement',
    ].join('|') +
    ')!?\\(',
  'g',
);

// Files whose matches are not Meshtastic sends (MeshCore backend; the ADS-B
// lookup queue's own `enqueue`).
const NOT_MESHTASTIC = new Set([
  'src/server/meshcoreNativeBackend.ts',
  'src/server/services/adsbMatchService.ts',
]);

/**
 * Expected match counts. These are regex matches, not strictly call sites:
 * wrapper bodies and delegates count too. Only a change in the number matters. Every automation site in these files is tagged;
 * the few manual ones are noted.
 */
const EXPECTED: Record<string, number> = {
  // All automation: auto-ack, auto-responder, timers, geofences, auto-welcome,
  // auto-ping, auto-traceroute, key repair, remote LocalStats, telemetry
  // auto-retry, message forwarding (#5446, 2 enqueueAutomation calls). Also counts the helpers themselves, the queue send callback
  // (origin comes from the queued entry), and thin delegates that pass the
  // caller's origin through (broadcastWaypointDelete, sendAutoAnnouncement,
  // broadcastNodeInfoToChannel[s]). Reliable PKI priming NodeInfo (#5691).
  'src/server/meshtasticManager.ts': 41,
  // Queue send + NodeInfo broadcast; origin follows triggeredByAutomation
  // (the "Send Announcement" button is manual). Plus the scheduler's calls.
  'src/server/services/autoAnnounceService.ts': 5,
  // #5704: position requests to a newly flagged aircraft; tagged automation.
  'src/server/services/aircraftPositionRequestService.ts': 1,
  'src/server/services/autoFavoriteManagementService.ts': 1,
  // Automation Engine: action.broadcastWaypoint calls deps.broadcastWaypoint
  // (#5482); the real dep is waypointService.upsertAndBroadcastForAutomation,
  // which tags the send.
  'src/server/services/automation/actionExecutor.ts': 1,
  // Automation Engine actions — all tagged.
  'src/server/services/automation/meshActionDeps.ts': 9,
  // Manual via routes (copyNodeInfo), automation via the enrichment scheduler
  // (pushNodeInfoRequestForNode) — the origin is a parameter.
  'src/server/services/nodeInfoCopyService.ts': 1,
  // Scheduled waypoint rebroadcast and the Automation Engine waypoint
  // action (#5482) — both tagged.
  'src/server/services/waypointService.ts': 2,
};

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'routes' || name === 'node_modules' || name === 'test-helpers') continue;
      walk(p, out);
    } else if (name.endsWith('.ts') && !name.includes('.test.') && !name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
}

describe('automation send callers are pinned (#5414)', () => {
  it('matches the reviewed set of non-route Meshtastic send call sites', () => {
    const files: string[] = [];
    walk(SERVER_DIR, files);
    const actual: Record<string, number> = {};
    for (const f of files) {
      const rel = relative(REPO_ROOT, f).split('\\').join('/');
      if (NOT_MESHTASTIC.has(rel)) continue;
      const n = (readFileSync(f, 'utf8').match(SEND_CALL) ?? []).length;
      if (n > 0) actual[rel] = n;
    }
    expect(
      actual,
      'A Meshtastic send call site was added or removed outside src/server/routes. ' +
        "Tag it { origin: 'automation' } if MeshMonitor sends it on its own, then update EXPECTED " +
        '(see the header of this file).',
    ).toEqual(EXPECTED);
  });

  it('MeshtasticManager only enqueues through the automation helper', () => {
    const src = readFileSync(join(SERVER_DIR, 'meshtasticManager.ts'), 'utf8');
    // The single raw call is the one inside enqueueAutomation itself.
    expect(src.match(/this\.messageQueue\.enqueue\(/g) ?? []).toHaveLength(1);
  });
});
