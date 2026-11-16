/**
 * The frontend bundle imports this module for PortNum and other constants.
 * Browsers have no `Buffer`, so evaluating the module must not touch it at load
 * time — a module-scope Buffer.from() once blanked the whole app.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

describe('meshtastic constants module in a browser-like global scope', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('loads without Buffer defined', async () => {
    vi.stubGlobal('Buffer', undefined);
    vi.resetModules();
    const mod = await import('./meshtastic.js');
    expect(mod.PortNum.TEXT_MESSAGE_APP).toBe(1);
  });

  it('still gives the server a real Buffer for the default key', async () => {
    vi.resetModules();
    const mod = await import('./meshtastic.js');
    expect(Buffer.isBuffer(mod.MESHTASTIC_DEFAULT_KEY)).toBe(true);
    expect(mod.MESHTASTIC_DEFAULT_KEY.toString('base64')).toBe('1PG7OiApB1nwvP+rz05pAQ==');
  });
});
