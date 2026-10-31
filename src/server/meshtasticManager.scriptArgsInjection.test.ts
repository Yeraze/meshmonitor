import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { MeshtasticManager } from './meshtasticManager.js';
import databaseService from '../services/database.js';

// SECURITY regression test for #6090 — Remote argv injection via OTA node names
// in the meshtasticManager script runners (auto-responder / geofence / timer).
//
// The script-args template holds tokens like {LONG_NAME} / {SHORT_NAME} whose
// values come from over-the-air mesh traffic (a node's self-reported name). The
// old runners expanded the whole template string and THEN split it into argv
// (expand-then-split), so a crafted node name carrying spaces or quotes split
// into extra argv elements — a remote injection vector. The fix tokenizes the
// admin-authored template into argv FIRST, then expands tokens per element
// (`expandScriptArgsTokens`), confining each OTA value to a single argument.

const execFileAsync = promisify(execFile);

vi.mock('../services/database.js', () => ({
  default: {
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      getSettingForSource: vi.fn().mockResolvedValue(null),
    },
    nodes: {
      getNode: vi.fn(),
    },
    channels: {
      getChannelById: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock('./messageQueueService.js', () => {
  const mockInstance = {
    enqueue: vi.fn(),
    setSendCallback: vi.fn(),
    clear: vi.fn(),
    getStatus: vi.fn(() => ({ queueLength: 0, pendingAcks: 0, processing: false })),
  };
  function MessageQueueService() { return mockInstance as any; }
  return { messageQueueService: mockInstance, MessageQueueService };
});

describe('MeshtasticManager - script-args argv injection via OTA node name (#6090)', () => {
  const FROM_NUM = 0x11223344;
  // A node name a hostile peer could advertise over the air: spaces, quotes,
  // shell metacharacters, and an injected flag.
  const EVIL_NAME = 'evil name "; rm -rf $(whoami) --output-to=/etc/passwd';

  // Bind the auto-responder's real token replacer the way the live runner does.
  const ackExpander = (manager: MeshtasticManager) => (part: string) =>
    (manager as any).replaceAcknowledgementTokens(
      part, '!11223344', FROM_NUM, 0, '01/01/2026', '12:00', 0, false,
    );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps an OTA node name with spaces/quotes/metacharacters as a SINGLE argv element', async () => {
    const manager = new MeshtasticManager('source-b');
    vi.mocked(databaseService.nodes.getNode).mockResolvedValue({
      nodeNum: FROM_NUM,
      longName: EVIL_NAME,
      shortName: 'EV',
    } as any);

    const parts = await (manager as any).expandScriptArgsTokens('{LONG_NAME}', ackExpander(manager));

    // The whole hostile name stays in one argument — it does NOT split into
    // "evil", "name", '"; rm -rf' … etc.
    expect(parts).toEqual([EVIL_NAME]);
  });

  it('preserves the admin template structure while confining expanded tokens per element', async () => {
    const manager = new MeshtasticManager('source-b');
    vi.mocked(databaseService.nodes.getNode).mockResolvedValue({
      nodeNum: FROM_NUM,
      longName: EVIL_NAME,
      shortName: 'EV',
    } as any);

    // Admin-authored template with fixed argv boundaries around the OTA tokens.
    const parts = await (manager as any).expandScriptArgsTokens(
      '--name {LONG_NAME} --id {SHORT_NAME}',
      ackExpander(manager),
    );

    // Exactly four argv elements, with the hostile name as one of them.
    expect(parts).toEqual(['--name', EVIL_NAME, '--id', 'EV']);
  });

  it('documents the old (vulnerable) expand-then-split ordering that this fixes', async () => {
    const manager = new MeshtasticManager('source-b');
    vi.mocked(databaseService.nodes.getNode).mockResolvedValue({
      nodeNum: FROM_NUM,
      longName: EVIL_NAME,
      shortName: 'EV',
    } as any);

    // Reproduce the PRE-FIX runner: expand the full template first, then split.
    const expandedFirst = await (manager as any).replaceAcknowledgementTokens(
      '{LONG_NAME}', '!11223344', FROM_NUM, 0, '01/01/2026', '12:00', 0, false,
    );
    const oldParts = (manager as any).parseScriptArgs(expandedFirst);

    // Before the fix a single template token exploded into many argv elements.
    expect(oldParts.length).toBeGreaterThan(1);

    // After the fix the same input yields exactly one argument.
    const newParts = await (manager as any).expandScriptArgsTokens('{LONG_NAME}', ackExpander(manager));
    expect(newParts).toEqual([EVIL_NAME]);
    expect(newParts.length).toBeLessThan(oldParts.length);
  });

  // End-to-end proof: the computed argv reaches a real child process as ONE
  // positional argument (execFileAsync passes the array as argv, no shell).
  it.skipIf(process.platform === 'win32')(
    'passes the hostile name to a spawned script as one positional arg ($# === 1)',
    async () => {
      const manager = new MeshtasticManager('source-b');
      vi.mocked(databaseService.nodes.getNode).mockResolvedValue({
        nodeNum: FROM_NUM,
        longName: EVIL_NAME,
        shortName: 'EV',
      } as any);

      const parts = await (manager as any).expandScriptArgsTokens('{LONG_NAME}', ackExpander(manager));

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-argv-'));
      const scriptPath = path.join(tmpDir, 'argc.sh');
      // Print the positional-arg count the child actually received.
      fs.writeFileSync(scriptPath, '#!/bin/sh\nprintf \'%s\' "$#"\n', { mode: 0o755 });
      try {
        const { stdout } = await execFileAsync('sh', [scriptPath, ...parts], { timeout: 10000 });
        expect(stdout.trim()).toBe('1');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );
});
