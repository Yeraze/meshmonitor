/**
 * #4173 review L21: the "Cannot connect" banner showed no address on the first
 * check. App runs that check straight after /api/config resolves, inside the
 * same async function, so the `nodeAddress` its closure holds is still the
 * empty mount-time value. The host must come from a ref that the config load
 * writes synchronously, like the port already does (`nodePortRef`).
 *
 * App.tsx is too large to render here for this one branch, so this pins the
 * wiring in the source.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const app = readFileSync(join(__dirname, 'App.tsx'), 'utf8');

describe('App connection banner host (#4173 review L21)', () => {
  it('falls back to the host ref, not the nodeAddress closure', () => {
    const m = app.match(/const resolvedHost =([\s\S]*?);/);
    expect(m).not.toBeNull();
    expect(m![1]).toContain('nodeHostRef.current');
    expect(m![1]).not.toMatch(/:\s*nodeAddress\b/);
  });

  it('writes the host ref wherever the config load sets the address', () => {
    expect(app).toMatch(/setNodeAddress\(host\);\s*nodeHostRef\.current = host;/);
    expect(app).toMatch(/setNodeAddress\(status\.nodeIp\);\s*nodeHostRef\.current = status\.nodeIp;/);
  });
});
