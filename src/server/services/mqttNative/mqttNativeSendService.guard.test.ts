/**
 * #4305 decision 4: automations may NOT send over the MQTT-native path in v1.
 *
 * The send service is reachable only from the authenticated user route and
 * the NodeInfo scheduler. This test pins that by scanning the server source:
 * any new importer of the send service (an automation action, auto-responder,
 * auto-ack, auto-announce, auto-welcome, timer, the v1 API...) fails here and
 * has to be a conscious, reviewed change. It also pins that the MQTT managers
 * expose no `sendTextMessage`, which is what every automation path calls.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const ALLOWED_IMPORTERS = new Set([
  'routes/mqttNativeRoutes.ts',
  'services/mqttNative/mqttNativeNodeInfoScheduler.ts',
]);

describe('MQTT-native send is user-only (#4305)', () => {
  it('only the user route and the NodeInfo scheduler import the send service at runtime', () => {
    const offenders: string[] = [];
    const found: string[] = [];
    for (const file of walk(SERVER_ROOT)) {
      const rel = path.relative(SERVER_ROOT, file).split(path.sep).join('/');
      if (rel === 'services/mqttNative/mqttNativeSendService.ts') continue;
      const src = fs.readFileSync(file, 'utf8');
      // Value imports only; `import type` is erased at compile time.
      const re = /^import\s+(?!type\b)[^;]*?from\s+['"][^'"]*mqttNativeSendService(\.js)?['"]/gms;
      if (!re.test(src)) continue;
      found.push(rel);
      if (!ALLOWED_IMPORTERS.has(rel)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
    // The scan itself works: it sees the two sanctioned importers.
    expect(found.sort()).toEqual([...ALLOWED_IMPORTERS].sort());
  });

  it('the MQTT managers have no sendTextMessage for an automation to call', () => {
    for (const rel of ['mqttBridgeManager.ts', 'mqttBrokerManager.ts']) {
      const src = fs.readFileSync(path.join(SERVER_ROOT, rel), 'utf8');
      expect(src).not.toMatch(/\bsendTextMessage\s*\(/);
    }
  });

  it('the send entry point requires a signed-in user id', () => {
    const src = fs.readFileSync(path.join(SERVER_ROOT, 'services/mqttNative/mqttNativeSendService.ts'), 'utf8');
    expect(src).toMatch(/INVALID_ORIGIN/);
  });
});
