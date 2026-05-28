import { describe, it, expect, vi } from 'vitest';
import { replaceMeshCoreAnnounceTokens } from './meshcoreAnnounceTokens.js';
import { MeshCoreDeviceType } from '../meshcoreManager.js';

/**
 * Token replacement is plain-text substitution with no I/O, so we mock
 * the manager surface to exercise every branch without booting a
 * MeshCoreManager instance.
 */
function makeManager(opts: {
  contacts?: Array<{ advType: MeshCoreDeviceType }>;
  local?: { name?: string; publicKey?: string } | null;
}) {
  return {
    getContacts: vi.fn(() => opts.contacts || []),
    getLocalNode: vi.fn(() => opts.local ?? null),
  } as any;
}

describe('replaceMeshCoreAnnounceTokens', () => {
  it('replaces version and duration using ctx overrides', async () => {
    const mgr = makeManager({});
    const out = await replaceMeshCoreAnnounceTokens(
      'v{VERSION} up {DURATION}',
      mgr,
      { version: '9.9.9', uptimeMs: 65 * 60_000 },
    );
    expect(out).toBe('v9.9.9 up 1h 5m');
  });

  it('counts contacts by advType', async () => {
    const mgr = makeManager({
      contacts: [
        { advType: MeshCoreDeviceType.COMPANION },
        { advType: MeshCoreDeviceType.COMPANION },
        { advType: MeshCoreDeviceType.REPEATER },
        { advType: MeshCoreDeviceType.ROOM_SERVER },
      ],
    });
    const out = await replaceMeshCoreAnnounceTokens(
      '{CONTACTCOUNT} ({COMPANIONCOUNT}/{REPEATERCOUNT}/{ROOMCOUNT})',
      mgr,
      { version: 't', uptimeMs: 0 },
    );
    expect(out).toBe('4 (2/1/1)');
  });

  it('renders {NODE_NAME} and {NODE_ID} from the local node', async () => {
    const mgr = makeManager({
      local: { name: 'TestStation', publicKey: 'abcdef0123456789cafe' },
    });
    const out = await replaceMeshCoreAnnounceTokens('{NODE_NAME} #{NODE_ID}', mgr, {
      version: 't',
      uptimeMs: 0,
    });
    expect(out).toBe('TestStation #abcdef0123456789');
  });

  it('falls back gracefully when no manager is supplied', async () => {
    const out = await replaceMeshCoreAnnounceTokens(
      '{NODE_NAME} {CONTACTCOUNT} v{VERSION}',
      null,
      { version: '1.2.3', uptimeMs: 0 },
    );
    expect(out).toBe('MeshMonitor 0 v1.2.3');
  });

  it('leaves unknown tokens untouched (visible authoring error)', async () => {
    const mgr = makeManager({});
    const out = await replaceMeshCoreAnnounceTokens(
      'hello {NOT_A_TOKEN} {VERSION}',
      mgr,
      { version: 'x', uptimeMs: 0 },
    );
    expect(out).toBe('hello {NOT_A_TOKEN} x');
  });
});
